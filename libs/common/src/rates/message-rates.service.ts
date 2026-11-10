import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';

export type RateCategoryValue = 'WA_MARKETING' | 'WA_UTILITY' | 'WA_AUTHENTICATION';

export const RATE_CATEGORIES: RateCategoryValue[] = ['WA_MARKETING', 'WA_UTILITY', 'WA_AUTHENTICATION'];

export const RATE_CATEGORY_LABEL: Record<RateCategoryValue, string> = {
  WA_MARKETING:      'Marketing',
  WA_UTILITY:        'Utility',
  WA_AUTHENTICATION: 'Authentication',
};

/** Where an effective price came from. `unpriced` means no row at any scope — the message is free. */
export type RateSource = 'customer' | 'reseller' | 'platform' | 'unpriced' | 'charging-off';

export interface ResolvedRate {
  category:   RateCategoryValue;
  /** What this customer is actually charged, in paise. 0 when unpriced. */
  priceMinor: number;
  source:     RateSource;
  /** The price each scope has set, for "inherited / overridden" UI. Null where unset. */
  customerMinor: number | null;
  resellerMinor: number | null;
  platformMinor: number | null;
}

export function isRateCategory(value: string): value is RateCategoryValue {
  return (RATE_CATEGORIES as string[]).includes(value);
}

/** Maps a MessageTemplate.category string onto the RateCategory enum. */
export function rateCategoryForTemplate(category: string | null | undefined): RateCategoryValue {
  const upper = (category ?? '').toUpperCase();
  if (upper.includes('UTILITY')) return 'WA_UTILITY';
  if (upper.includes('AUTH'))    return 'WA_AUTHENTICATION';
  return 'WA_MARKETING';
}

const CACHE_TTL_MS = 60_000;

/**
 * The single authority on what a message costs a given customer.
 *
 * Precedence is customer → reseller → platform: a price set for one account wins over
 * its reseller's price for all clients, which wins over the platform default. Every
 * charge, every estimate and every price shown in the UI resolves through here, so the
 * number an operator sets is the number that gets debited.
 *
 * Above all of it sits the platform's wallet switch. Turned off, nobody is charged for a
 * message anywhere on the platform, whatever rows exist underneath — zeroing the rates
 * instead would have left a reseller free to price their own clients tomorrow and quietly
 * start charging again. The rows are kept as they are, so turning it back on restores the
 * prices that were set rather than losing them.
 */
@Injectable()
export class MessageRatesService {
  private readonly logger = new Logger(MessageRatesService.name);
  private readonly cache = new Map<string, { rates: ResolvedRate[]; expiresAt: number }>();

  constructor(private readonly prisma: PrismaService) {}

  // ── Resolution ──────────────────────────────────────────────────────────────

  async resolveAll(tenantId: string): Promise<ResolvedRate[]> {
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.rates;

    if (!(await this.chargingOn())) {
      const free = RATE_CATEGORIES.map<ResolvedRate>((category) => ({
        category, priceMinor: 0, source: 'charging-off',
        customerMinor: null, resellerMinor: null, platformMinor: null,
      }));
      this.cache.set(tenantId, { rates: free, expiresAt: Date.now() + CACHE_TTL_MS });
      return free;
    }

    const tenant = await this.prisma.tenant.findUnique({
      where:  { id: tenantId },
      select: { id: true, parentId: true },
    });

    // One query covers all three scopes that could apply to this tenant.
    const rows = await this.prisma.messageRate.findMany({
      where: {
        OR: [
          { tenantId },
          ...(tenant?.parentId ? [{ resellerId: tenant.parentId, tenantId: null }] : []),
          { resellerId: null, tenantId: null },
        ],
      },
      select: { category: true, priceMinor: true, resellerId: true, tenantId: true },
    });

    const pick = (category: string, test: (r: typeof rows[number]) => boolean) => {
      const row = rows.find(r => r.category === category && test(r));
      return row ? row.priceMinor : null;
    };

    const rates = RATE_CATEGORIES.map<ResolvedRate>(category => {
      const customerMinor = pick(category, r => r.tenantId === tenantId);
      const resellerMinor = tenant?.parentId ? pick(category, r => r.resellerId === tenant.parentId && r.tenantId === null) : null;
      const platformMinor = pick(category, r => r.resellerId === null && r.tenantId === null);

      const source: RateSource =
        customerMinor !== null ? 'customer'
        : resellerMinor !== null ? 'reseller'
        : platformMinor !== null ? 'platform'
        : 'unpriced';
      const priceMinor = customerMinor ?? resellerMinor ?? platformMinor ?? 0;

      return { category, priceMinor, source, customerMinor, resellerMinor, platformMinor };
    });

    this.cache.set(tenantId, { rates, expiresAt: Date.now() + CACHE_TTL_MS });
    return rates;
  }

  async resolve(tenantId: string, category: RateCategoryValue): Promise<ResolvedRate> {
    const all = await this.resolveAll(tenantId);
    return all.find(r => r.category === category) ?? {
      category, priceMinor: 0, source: 'unpriced', customerMinor: null, resellerMinor: null, platformMinor: null,
    };
  }

  /** Price for a message sent on a template of this category, in paise. */
  async priceFor(tenantId: string, templateCategory: string | null | undefined): Promise<number> {
    const { priceMinor } = await this.resolve(tenantId, rateCategoryForTemplate(templateCategory));
    return priceMinor;
  }

  /**
   * The platform's master switch, shared with wallet top-ups. Read on its own so one
   * database row decides it for every account rather than each caller remembering to ask.
   */
  private async chargingOn(): Promise<boolean> {
    const platform = await this.prisma.tenant.findFirst({
      where:  { accountType: 'PLATFORM' },
      select: { settings: { select: { walletEnabled: true } } },
    }).catch(() => null);
    // Missing settings mean nothing has been configured yet, and charging for messages
    // before anyone has set a price is the wrong way to be wrong.
    return platform?.settings?.walletEnabled === true;
  }

  invalidate(tenantId?: string) {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }

  // ── Reads for the admin / reseller screens ──────────────────────────────────

  /** Platform defaults, one entry per category (null = not priced). */
  async listPlatform() {
    const rows = await this.prisma.messageRate.findMany({ where: { resellerId: null, tenantId: null } });
    const byCategory = new Map(rows.map(r => [r.category as string, r.priceMinor]));
    return RATE_CATEGORIES.map(category => ({ category, priceMinor: byCategory.get(category) ?? null }));
  }

  /** Every account that has its own price, with the prices it overrides. */
  async listCustomerOverrides(opts: { resellerId?: string } = {}) {
    const rows = await this.prisma.messageRate.findMany({
      where: {
        tenantId: { not: null },
        ...(opts.resellerId ? { tenant: { parentId: opts.resellerId } } : {}),
      },
      select: {
        category: true, priceMinor: true, updatedAt: true,
        tenant: { select: { id: true, name: true, slug: true, accountType: true, parentId: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const byTenant = new Map<string, {
      tenant: NonNullable<typeof rows[number]['tenant']>;
      prices: Record<string, number>;
      updatedAt: Date;
    }>();
    for (const row of rows) {
      if (!row.tenant) continue;
      const entry = byTenant.get(row.tenant.id) ?? { tenant: row.tenant, prices: {}, updatedAt: row.updatedAt };
      entry.prices[row.category as string] = row.priceMinor;
      if (row.updatedAt > entry.updatedAt) entry.updatedAt = row.updatedAt;
      byTenant.set(row.tenant.id, entry);
    }

    return Promise.all([...byTenant.values()].map(async entry => ({
      tenant:    entry.tenant,
      updatedAt: entry.updatedAt,
      rates:     await this.resolveAll(entry.tenant.id),
    })));
  }

  // ── Writes ──────────────────────────────────────────────────────────────────

  /** Platform default. `priceMinor: null` removes it, making the category free. */
  async setPlatform(category: string, priceMinor: number | null) {
    const cat = this.assertCategory(category);
    await this.write({ category: cat, resellerId: null, tenantId: null }, priceMinor);
    this.invalidate(); // every tenant may inherit this
    return this.listPlatform();
  }

  /**
   * A reseller's price for all of its clients. Must not undercut the platform price —
   * that is the reseller's own cost, so below it every message loses money.
   */
  async setReseller(resellerId: string, category: string, priceMinor: number | null) {
    const cat = this.assertCategory(category);
    if (priceMinor !== null) {
      const floor = await this.platformPrice(cat);
      if (floor !== null && priceMinor < floor) {
        throw new BadRequestException(`Price must be at least ${floor} paise — that is the platform price you pay.`);
      }
    }
    await this.write({ category: cat, resellerId, tenantId: null }, priceMinor);
    this.invalidate();
    return this.resolveAllForReseller(resellerId);
  }

  /**
   * One account's own price. `priceMinor: null` removes the override so the account falls
   * back to its reseller's or the platform's price.
   *
   * `floorToPlatform` is set when a reseller is pricing its own client: it may discount
   * against its own list price but not below what the platform charges it.
   */
  async setCustomer(tenantId: string, category: string, priceMinor: number | null, opts: { floorToPlatform?: boolean } = {}) {
    const cat = this.assertCategory(category);
    if (priceMinor !== null) {
      if (priceMinor < 0) throw new BadRequestException('Price cannot be negative');
      if (opts.floorToPlatform) {
        const floor = await this.platformPrice(cat);
        if (floor !== null && priceMinor < floor) {
          throw new BadRequestException(`Price must be at least ${floor} paise — that is the platform price you pay.`);
        }
      }
    }
    await this.write({ category: cat, resellerId: null, tenantId }, priceMinor);
    this.invalidate(tenantId);
    return this.resolveAll(tenantId);
  }

  async resolveAllForReseller(resellerId: string) {
    const [platform, own] = await Promise.all([
      this.listPlatform(),
      this.prisma.messageRate.findMany({ where: { resellerId, tenantId: null } }),
    ]);
    const ownMap = new Map(own.map(r => [r.category as string, r.priceMinor]));
    return platform.map(p => ({
      category:      p.category,
      platformMinor: p.priceMinor,
      yoursMinor:    ownMap.get(p.category) ?? null,
    }));
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private assertCategory(category: string): RateCategoryValue {
    if (!isRateCategory(category)) throw new BadRequestException(`Unknown message category: ${category}`);
    return category;
  }

  private async platformPrice(category: RateCategoryValue): Promise<number | null> {
    const row = await this.prisma.messageRate.findFirst({
      where:  { category: category as never, resellerId: null, tenantId: null },
      select: { priceMinor: true },
    });
    return row?.priceMinor ?? null;
  }

  /**
   * Upsert-or-delete for one scope. Done as findFirst + update/create rather than
   * `upsert`, because the scope is identified by NULLs and Prisma's compound-unique
   * lookups cannot express "this NULL combination" reliably.
   */
  private async write(
    scope: { category: RateCategoryValue; resellerId: string | null; tenantId: string | null },
    priceMinor: number | null,
  ) {
    const where = {
      category:   scope.category as never,
      resellerId: scope.resellerId,
      tenantId:   scope.tenantId,
    };
    const existing = await this.prisma.messageRate.findFirst({ where, select: { id: true } });

    if (priceMinor === null) {
      if (existing) await this.prisma.messageRate.delete({ where: { id: existing.id } });
      return;
    }
    if (!Number.isFinite(priceMinor) || priceMinor < 0) throw new BadRequestException('Price must be zero or more paise');
    const value = Math.round(priceMinor);

    if (existing) {
      await this.prisma.messageRate.update({ where: { id: existing.id }, data: { priceMinor: value } });
    } else {
      await this.prisma.messageRate.create({ data: { ...where, priceMinor: value } });
    }
  }
}
