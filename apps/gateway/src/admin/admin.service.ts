import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import {
  TenantScope, PERMISSIONS, accountCeiling, roleDefaults, resolvePermission, MessageRatesService, WalletService,
  decryptSecret, computeBulkPrices, type BulkPriceChange, PermissionsService,
  type Permission, PLATFORM_PERMISSIONS, requireFields, isInvitableRole,
} from '@lib/common';
import * as bcrypt from 'bcryptjs';

// ── CMS section metadata (mirrored from lib/cms/sections.ts — no Next.js imports) ──

const CMS_SECTIONS_META: Record<string, { label: string; description: string; whatsapp?: boolean; collections: string[] }> = {
  hero:         { label: 'Hero',          description: 'The first screen: headline, calls to action and the live WhatsApp chat demo.', whatsapp: true, collections: ['stat', 'event'] },
  logos:        { label: 'Trusted by',    description: 'The strip of customer names or logos under the hero.',                          collections: ['logo'] },
  stats:        { label: 'Stats',         description: 'A band of headline numbers.',                                                   collections: ['stat'] },
  problem:      { label: 'Problems',      description: 'What goes wrong when sales run on a shared WhatsApp phone.',                    collections: ['card'] },
  howItWorks:   { label: 'How It Works',  description: 'The path from a WhatsApp message to a qualified lead.', whatsapp: true,         collections: ['step'] },
  products:     { label: 'Products',      description: 'The platform feature cards.',                           whatsapp: true,         collections: ['product'] },
  ai:           { label: 'AI',            description: 'The AI spotlight: what the assistant does, and the insight panel beside it.', whatsapp: true, collections: ['feature', 'metric'] },
  messageTypes: { label: 'Message Types', description: 'The WhatsApp message formats the platform can send and receive.', whatsapp: true, collections: ['type'] },
  integrations: { label: 'Integrations',  description: 'The tools and channels the platform connects with.',                           collections: ['integration'] },
  industries:   { label: 'Industries',    description: "The \"who it's for\" strip of industry cards.",                                  collections: ['industry'] },
  testimonials: { label: 'Testimonials',  description: 'Customer quotes.',                                                             collections: ['testimonial'] },
  pricing:      { label: 'Pricing',       description: 'Plan cards on the homepage and the /pricing page.',                            collections: ['plan'] },
  faq:          { label: 'FAQ',           description: 'Frequently asked questions.',                                                  collections: ['faq'] },
  cta:          { label: 'CTA',           description: 'The closing call to action.',                                                  collections: [] },
  newsletter:   { label: 'Newsletter',    description: 'The email sign-up band above the footer.',                                     collections: [] },
  footer:       { label: 'Footer',        description: 'Shown on every marketing page: description, link columns and social links.',   collections: ['group', 'trust', 'social'] },
};

const CMS_SECTION_KEYS = Object.keys(CMS_SECTIONS_META);

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rates:  MessageRatesService,
    private readonly wallet: WalletService,
    private readonly permissions: PermissionsService,
  ) {}

  /**
   * Who may do this piece of running the platform.
   *
   * It used to be "are you the Super Admin", which left no room between all of it and
   * none of it — so taking on help meant handing over everything. A Super Admin still
   * passes everything (resolvePermission says so), and anyone else must hold the
   * permission for this particular area.
   *
   * A client's own ADMIN cannot reach any of this however their account is configured:
   * these permissions are outside the client ceiling, which `can` applies, so no role
   * default or override within an account can grant one.
   */
  private async guard(scope: TenantScope, permission?: Permission) {
    if (scope.role === 'SUPER_ADMIN') return;
    if (!permission) throw new ForbiddenException('Super admin only');
    if (!(await this.permissions.can(scope.userId, permission))) {
      throw new ForbiddenException('You do not have access to this part of the admin panel.');
    }
  }

  /**
   * Who may edit a homepage: the platform's own, or a white-label brand's.
   *
   * The rest of this service is the platform operator's, so it guards on super admin
   * alone. The CMS is the one part a reseller shares — it edits its own brand's copy,
   * never the platform's, which `cmsOwner` enforces by scoping every row to the tenant.
   */
  private async guardCms(scope: TenantScope) {
    if (scope.role === 'SUPER_ADMIN') return;
    if (!['TENANT_OWNER', 'ADMIN'].includes(scope.role ?? '')) {
      throw new ForbiddenException('Only a white-label reseller can edit its own website');
    }
    // The account type is not on the token, so it is read here rather than trusted.
    const tenant = await this.prisma.tenant.findUnique({
      where:  { id: scope.tenantId },
      select: { accountType: true, resellerType: true },
    });
    if (tenant?.accountType !== 'RESELLER' || tenant.resellerType !== 'WHITE_LABEL') {
      throw new ForbiddenException('Only a white-label reseller can edit its own website');
    }
  }

  // ── Tenants ────────────────────────────────────────────────────────────────

  async listTenants(
    scope: TenantScope,
    query: { page?: number; limit?: number; search?: string; accountType?: string; planId?: string; isActive?: string },
  ) {
    await this.guard(scope, 'platform.tenants.view');
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const skip  = (page - 1) * limit;

    const where: any = {};
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { slug: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.isActive !== undefined && query.isActive !== '') {
      where.isActive = query.isActive === 'true';
    }
    if (query.accountType) where.accountType = query.accountType;
    if (query.planId)      where.subscription = { planId: query.planId };

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [total, rows] = await Promise.all([
      this.prisma.tenant.count({ where }),
      this.prisma.tenant.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: {
              users: true,
              contacts: true,
              leads: true,
              children: true,
              whatsAppIntegrations: { where: { isActive: true } },
            },
          },
          subscription: { include: { plan: true } },
          parent:   { select: { id: true, name: true } },
          category: { select: { name: true } },
        },
      }),
    ]);

    const tenantIds = rows.map(t => t.id);

    // Counted over each tenant's own billing period rather than the calendar month.
    // The number is shown against the plan's monthly allowance, and an allowance resets
    // when the subscription renews — not on the first of the month. Counting by calendar
    // month also made every tenant read zero on the 1st, which looks like a broken column
    // rather than a reset. A tenant with no subscription has no period, so it falls back
    // to the month.
    const msgCounts = tenantIds.length
      ? await this.prisma.$queryRaw<{ tenantId: string; n: bigint }[]>`
          SELECT m."tenantId", COUNT(*) AS n
            FROM "messages" m
            LEFT JOIN "subscriptions" s ON s."tenantId" = m."tenantId"
           WHERE m."tenantId" = ANY(${tenantIds})
             AND m."createdAt" >= COALESCE(s."currentPeriodStart", ${startOfMonth})
           GROUP BY m."tenantId"`
      : [];
    const msgByTenant = new Map(msgCounts.map(r => [r.tenantId, Number(r.n)]));

    const data = rows.map(t => ({
      id:             t.id,
      name:           t.name,
      slug:           t.slug,
      logo:           (t as any).logo ?? null,
      isActive:       t.isActive,
      createdAt:      t.createdAt.toISOString(),
      accountType:    t.accountType,
      resellerType:   (t as any).resellerType ?? null,
      commissionRate: (t as any).commissionRate ?? null,
      parent:         t.parent ?? null,
      clients:        t._count.children,
      category:       t.category?.name ?? null,
      plan:           t.subscription?.plan?.displayName ?? null,
      users:          t._count.users,
      contacts:       t._count.contacts,
      leads:          t._count.leads,
      whatsappNumbers:   t._count.whatsAppIntegrations,
      messagesThisMonth: msgByTenant.get(t.id) ?? 0,
      messageLimit:      t.subscription?.plan
        ? (t.subscription.plan as any).maxMsgPerMonth ?? 0
        : 500,
    }));

    return {
      success:    true,
      data,
      pagination: { page, limit, total },
    };
  }

  async getTenant(scope: TenantScope, tenantId: string) {
    await this.guard(scope, 'platform.tenants.view');
    const tenant = await this.prisma.tenant.findUnique({
      where:   { id: tenantId },
      include: {
        subscription: { include: { plan: true } },
        users: {
          select: {
            id: true, name: true, email: true, phone: true,
            role: true, isActive: true, lastLoginAt: true, createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
        businesses:  { select: { id: true, name: true, slug: true } },
        category:    { select: { id: true, name: true } },
        parent:      { select: { id: true, name: true, resellerType: true } },
        referredBy:  { select: { id: true, name: true } },
        whiteLabel:  { select: { brandName: true, domain: true, isActive: true } },
        settings:    { select: { waPhoneNumberId: true, timezone: true } },
        _count: {
          select: {
            users: true,
            contacts: true,
            leads: true,
            conversations: true,
            children: true,
          },
        },
      },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');
    // Mask the WA token — expose only whether one is set
    const hasWaApiKey = !!(tenant.settings as any)?.waAccessToken;
    return {
      ...tenant,
      settings: tenant.settings
        ? { waPhoneNumberId: (tenant.settings as any).waPhoneNumberId, hasWaApiKey, timezone: (tenant.settings as any).timezone }
        : null,
    };
  }

  async updateTenant(scope: TenantScope, id: string, data: { isActive?: boolean; name?: string; categoryId?: string }) {
    await this.guard(scope, 'platform.tenants.manage');
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw new NotFoundException('Tenant not found');
    return this.prisma.tenant.update({ where: { id }, data: data as any });
  }

  // ── Audit Logs ─────────────────────────────────────────────────────────────

  async listAuditLogs(scope: TenantScope, query: { tenantId?: string; page?: number; limit?: number; q?: string }) {
    await this.guard(scope, 'platform.audit.view');
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const skip  = (page - 1) * limit;
    const where: any = {};
    if (query.tenantId) where.tenantId = query.tenantId;
    if (query.q) {
      where.OR = [
        { action:   { contains: query.q, mode: 'insensitive' } },
        { resource: { contains: query.q, mode: 'insensitive' } },
        { user: { name:  { contains: query.q, mode: 'insensitive' } } },
        { user: { email: { contains: query.q, mode: 'insensitive' } } },
      ];
    }

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user:   { select: { id: true, name: true, email: true } },
          tenant: { select: { name: true, slug: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { success: true, data: { data: logs, total } };
  }

  // ── Tenant Contacts (admin oversight) ─────────────────────────────────────

  async adminGetTenantContacts(scope: TenantScope, tenantId: string, query: { page?: number; limit?: number; search?: string }) {
    await this.guard(scope, 'platform.tenants.view');
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const skip  = (page - 1) * limit;
    const where: any = { tenantId };
    if (query.search) {
      where.OR = [
        { name:  { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [contacts, total] = await Promise.all([
      this.prisma.contact.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      this.prisma.contact.count({ where }),
    ]);
    return { contacts, total, page, limit };
  }

  // ── Reset Password ─────────────────────────────────────────────────────────

  async adminResetPassword(scope: TenantScope, userId: string, newPassword: string) {
    await this.guard(scope, 'platform.tenants.manage');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const hashed = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({ where: { id: userId }, data: { password: hashed } });
    return { success: true };
  }

  // ── Wallet ─────────────────────────────────────────────────────────────────

  /**
   * Flat on purpose: the panel reads `balanceMinor` and `transactions` straight off the
   * payload. It used to come back as `{ wallet, transactions }`, so the balance rendered
   * as NaN, and an account that had never been topped up 404'd instead of showing zero.
   */
  async adminGetTenantWallet(scope: TenantScope, tenantId: string) {
    await this.guard(scope, 'platform.tenants.view');
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) throw new NotFoundException('Account not found');

    const wallet = await this.wallet.ensure(tenantId);
    const transactions = await this.prisma.walletTransaction.findMany({
      where:   { tenantId },
      orderBy: { createdAt: 'desc' },
      take:    20,
    });
    return {
      balanceMinor:             Math.max(0, wallet.balanceMinor),
      currency:                 wallet.currency,
      lowBalanceThresholdMinor: wallet.lowBalanceThresholdMinor,
      transactions,
    };
  }

  /**
   * Add or take credit by hand. A positive `amount` adds, a negative one deducts — the
   * operator is free to enter either. Deducting more than the balance empties the wallet
   * rather than putting it into debt, and the shortfall is reported back so the UI can
   * say what actually happened.
   */
  async adminAdjustWallet(scope: TenantScope, tenantId: string, amount: number, note: string) {
    await this.guard(scope, 'platform.tenants.manage');
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) throw new NotFoundException('Account not found');
    const reason = (note ?? '').trim();
    if (!reason) throw new BadRequestException('Add a note so the adjustment can be explained later');

    const movement = await this.wallet.adjust(tenantId, amount, {
      description: reason,
      createdById: scope.userId,
      referenceType: 'admin_adjustment',
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId:   scope.tenantId,
        userId:     scope.userId,
        action:     'WALLET_ADJUSTED',
        resource:   'wallet',
        resourceId: tenantId,
        metadata:   { requestedMinor: Math.round(amount), appliedMinor: movement.appliedMinor, shortfallMinor: movement.shortfallMinor, note: reason },
      },
    });

    return {
      wallet:         { tenantId, balanceMinor: movement.balanceMinor },
      appliedMinor:   movement.appliedMinor,
      shortfallMinor: movement.shortfallMinor,
      balanceMinor:   movement.balanceMinor,
    };
  }

  // ── Business Categories ────────────────────────────────────────────────────

  async listCategories(scope: TenantScope) {
    await this.guard(scope, 'platform.tenants.view');
    const rows = await this.prisma.businessCategory.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { _count: { select: { tenants: true } } },
    });
    return {
      success: true,
      data: rows.map(r => ({
        id:        r.id,
        name:      r.name,
        isActive:  r.isActive,
        sortOrder: r.sortOrder,
        accounts:  r._count.tenants,
      })),
    };
  }

  async createCategory(scope: TenantScope, data: { name: string; isActive?: boolean; sortOrder?: number }) {
    await this.guard(scope, 'platform.categories.manage');
    const created = await this.prisma.businessCategory.create({ data: data as any });
    return { success: true, data: { ...created, accounts: 0 } };
  }

  async updateCategory(scope: TenantScope, id: string, data: { name?: string; isActive?: boolean; sortOrder?: number }) {
    await this.guard(scope, 'platform.categories.manage');
    const cat = await this.prisma.businessCategory.findUnique({ where: { id } });
    if (!cat) throw new NotFoundException('Category not found');
    const updated = await this.prisma.businessCategory.update({ where: { id }, data: data as any });
    return { success: true, data: updated };
  }

  async deleteCategory(scope: TenantScope, id: string) {
    await this.guard(scope, 'platform.categories.manage');
    const cat = await this.prisma.businessCategory.findUnique({ where: { id } });
    if (!cat) throw new NotFoundException('Category not found');
    const usageCount = await this.prisma.tenant.count({ where: { categoryId: id } });
    if (usageCount > 0) throw new BadRequestException('Category is used by active workspaces');
    await this.prisma.businessCategory.delete({ where: { id } });
    return { success: true };
  }

  // ── Message Rates ──────────────────────────────────────────────────────────

  async listRates(scope: TenantScope) {
    await this.guard(scope, 'platform.pricing.manage');
    const [platform, customers] = await Promise.all([
      this.rates.listPlatform(),
      this.rates.listCustomerOverrides(),
    ]);
    return { success: true, data: platform, customers };
  }

  /** Effective prices for one account, with the platform/reseller values it inherits. */
  async getTenantRates(scope: TenantScope, tenantId: string) {
    await this.guard(scope, 'platform.tenants.view');
    const tenant = await this.prisma.tenant.findUnique({
      where:  { id: tenantId },
      select: { id: true, name: true, accountType: true, parent: { select: { id: true, name: true } } },
    });
    if (!tenant) throw new NotFoundException('Account not found');
    return { success: true, data: { tenant, rates: await this.rates.resolveAll(tenantId) } };
  }

  /**
   * Set or clear a price. The scope is whichever id is supplied: `tenantId` prices one
   * account, `resellerId` prices a reseller's clients, neither sets the platform default.
   * A null `priceMinor` removes the row so the next scope up applies again.
   */
  async updateRate(
    scope: TenantScope,
    category: string,
    resellerId: string | null | undefined,
    priceMinor: number | null | undefined,
    tenantId?: string | null,
  ) {
    await this.guard(scope, 'platform.pricing.manage');
    const price = priceMinor ?? null;

    if (tenantId) {
      const exists = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
      if (!exists) throw new NotFoundException('Account not found');
      await this.rates.setCustomer(tenantId, category, price);
    } else if (resellerId) {
      const reseller = await this.prisma.tenant.findUnique({ where: { id: resellerId }, select: { accountType: true } });
      if (reseller?.accountType !== 'RESELLER') throw new BadRequestException('That account is not a reseller');
      await this.rates.setReseller(resellerId, category, price);
    } else {
      await this.rates.setPlatform(category, price);
    }

    await this.prisma.auditLog.create({
      data: {
        tenantId:   scope.tenantId,
        userId:     scope.userId,
        action:     'RATE_UPDATED',
        resource:   'messageRate',
        resourceId: category,
        metadata:   { priceMinor: price, resellerId: resellerId ?? null, forTenantId: tenantId ?? null },
      },
    });
    return { success: true };
  }

  // ── Plans ──────────────────────────────────────────────────────────────────

  async listPlans(scope: TenantScope) {
    await this.guard(scope, 'platform.tenants.view');
    return this.prisma.plan.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  async createPlan(scope: TenantScope, data: {
    name: string; displayName: string; description?: string;
    priceMonthly: number; priceAnnual: number;
    maxContacts: number; maxMsgPerMonth: number; maxAgents: number;
    maxCampaigns: number; aiEnabled?: boolean; features?: string[];
  }) {
    await this.guard(scope, 'platform.plans.manage');
    return this.prisma.plan.create({ data: data as any });
  }

  async updatePlan(scope: TenantScope, planId: string, data: Record<string, unknown>) {
    await this.guard(scope, 'platform.plans.manage');
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
    return this.prisma.plan.update({ where: { id: planId }, data: data as any });
  }

  // ── Assign plan to tenant ──────────────────────────────────────────────────

  async assignPlan(scope: TenantScope, tenantId: string, planId: string, billingCycle: string) {
    await this.guard(scope, 'platform.tenants.manage');
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
    const now = new Date();
    const end = billingCycle === 'ANNUAL'
      ? new Date(now.getFullYear() + 1, now.getMonth(), now.getDate())
      : new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());

    return this.prisma.subscription.upsert({
      where:  { tenantId },
      create: {
        tenantId,
        planId,
        status:             'ACTIVE',
        billingCycle:       billingCycle as any,
        currentPeriodStart: now,
        currentPeriodEnd:   end,
        planLockedAt:       plan.stripePriceId ? undefined : now,
      },
      update: {
        planId,
        status:             'ACTIVE',
        billingCycle:       billingCycle as any,
        currentPeriodStart: now,
        currentPeriodEnd:   end,
        planLockedAt:       plan.stripePriceId ? null : now,
      },
    });
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getStats(scope: TenantScope) {
    await this.guard(scope, 'platform.tenants.view');

    const now = new Date();
    const thirtyDaysAgo  = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [
      totalTenants,
      activeTenants,
      totalUsers,
      totalMessages,
      signupsThisMonth,
      signupsLastMonth,
      activeSubscriptions,
      recentTenantsRaw,
      signupDays,
      planBreakdownRaw,
      cancelledThisMonth,
    ] = await Promise.all([
      this.prisma.tenant.count(),
      this.prisma.tenant.count({ where: { isActive: true } }),
      this.prisma.user.count({ where: { role: { not: 'SUPER_ADMIN' } } }),
      this.prisma.message.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      this.prisma.tenant.count({ where: { createdAt: { gte: thisMonthStart } } }),
      this.prisma.tenant.count({ where: { createdAt: { gte: lastMonthStart, lt: thisMonthStart } } }),
      this.prisma.subscription.findMany({
        where:   { status: { in: ['ACTIVE', 'TRIALING'] } },
        include: { plan: { select: { priceMonthly: true, displayName: true, name: true } } },
      }),
      this.prisma.tenant.findMany({
        orderBy: { createdAt: 'desc' },
        take:    5,
        include: {
          subscription: { include: { plan: { select: { displayName: true } } } },
          _count:        { select: { users: true } },
        },
      }),
      this.prisma.tenant.findMany({
        where:   { createdAt: { gte: thirtyDaysAgo } },
        select:  { createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.subscription.groupBy({
        by:    ['planId'],
        where: { status: { in: ['ACTIVE', 'TRIALING'] } },
        _count: { _all: true },
      }),
      this.prisma.subscription.count({
        where: { status: 'CANCELLED', cancelledAt: { gte: thisMonthStart } },
      }),
    ]);

    const mrr = activeSubscriptions.reduce((s, sub) => s + (sub.plan?.priceMonthly ?? 0), 0);
    const churnRate = signupsLastMonth > 0
      ? Math.round((cancelledThisMonth / Math.max(signupsLastMonth, 1)) * 1000) / 10
      : 0;

    const signupMap: Record<string, number> = {};
    for (const { createdAt } of signupDays) {
      const date = createdAt.toISOString().slice(0, 10);
      signupMap[date] = (signupMap[date] ?? 0) + 1;
    }
    const signupsLast30Days = Object.entries(signupMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    const planNames: Record<string, string> = {};
    for (const sub of activeSubscriptions) {
      planNames[sub.planId] = sub.plan?.displayName ?? sub.plan?.name ?? sub.planId;
    }
    const planBreakdown = planBreakdownRaw.map(p => ({
      planName: planNames[p.planId] ?? p.planId,
      count:    p._count._all,
    }));

    const recentTenants = recentTenantsRaw.map(t => ({
      id:        t.id,
      name:      t.name,
      slug:      t.slug,
      plan:      t.subscription?.plan?.displayName ?? null,
      users:     t._count.users,
      createdAt: t.createdAt.toISOString(),
    }));

    return {
      success: true,
      data: {
        totalTenants,
        activeTenants,
        totalUsers,
        totalMessages,
        mrr,
        arr: mrr * 12,
        signupsThisMonth,
        churnRate,
        signupsLast30Days,
        planBreakdown,
        recentTenants,
      },
    };
  }

  // ── Revenue ────────────────────────────────────────────────────────────────

  async getRevenue(scope: TenantScope, query: { range?: string }) {
    await this.guard(scope, 'platform.revenue.view');

    const months = query.range === '3m' ? 3 : query.range === '6m' ? 6 : 12;
    const now = new Date();

    // Build calendar-month window (oldest first, ending in current month)
    const window = Array.from({ length: months }, (_, i) => {
      const start = new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1);
      const end   = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);
      const label = start.toLocaleString('en-IN', { month: 'short', year: '2-digit' });
      return { start, end, label };
    });

    const subscriptions = await this.prisma.subscription.findMany({
      include: {
        plan:   { select: { name: true, displayName: true, priceMonthly: true } },
        tenant: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const ACTIVE = ['ACTIVE', 'TRIALING'];
    const active = subscriptions.filter(s => ACTIVE.includes(s.status));
    const mrr    = active.reduce((sum, s) => sum + (s.plan?.priceMonthly ?? 0), 0);
    const arpu   = active.length > 0 ? Math.round(mrr / active.length) : 0;

    // Monthly MRR: a subscription is live in a month if it started before month end
    // and hasn't been cancelled before month start
    const trend = window.map(m => {
      const live = subscriptions.filter(s =>
        s.createdAt <= m.end &&
        (s.cancelledAt === null || s.cancelledAt > m.start),
      );
      const mrrByPlanName: Record<string, number> = {};
      for (const s of live) {
        const key = s.plan?.name ?? 'UNKNOWN';
        mrrByPlanName[key] = (mrrByPlanName[key] ?? 0) + (s.plan?.priceMonthly ?? 0);
      }
      return {
        month: m.label,
        mrr:   live.reduce((sum, s) => sum + (s.plan?.priceMonthly ?? 0), 0),
        mrrByPlanName,
      };
    });

    const byPlan = trend.map(m => ({
      month:      m.month,
      starter:    m.mrrByPlanName['STARTER']    ?? 0,
      growth:     m.mrrByPlanName['GROWTH']     ?? 0,
      enterprise: m.mrrByPlanName['ENTERPRISE'] ?? 0,
    }));

    return {
      success: true,
      data: {
        mrr,
        arr:  mrr * 12,
        arpu,
        ltv:  arpu * 24,
        trend: trend.map(m => ({ month: m.month, mrr: m.mrr })),
        byPlan,
        transactions: [],
        failed:       [],
        collected: {
          available:          false,
          unavailableReason:  'Stripe is not configured on this deployment.',
          totalTransactions:  0,
        },
      },
    };
  }

  async getRevenueExport(scope: TenantScope, query: { days?: number }) {
    await this.guard(scope, 'platform.revenue.view');
    const since = new Date(Date.now() - (query.days ?? 30) * 86_400_000);
    const subs  = await this.prisma.subscription.findMany({
      where:   { status: { in: ['ACTIVE', 'TRIALING'] }, createdAt: { gte: since } },
      include: { plan: { select: { displayName: true, priceMonthly: true } }, tenant: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const header = 'tenantId,tenantName,plan,priceMonthly,createdAt';
    const rows = subs.map(s =>
      `${s.tenantId},${s.tenant?.name ?? ''},${s.plan?.displayName ?? ''},${s.plan?.priceMonthly ?? 0},${s.createdAt.toISOString()}`,
    );
    return [header, ...rows].join('\n');
  }

  // ── Reports ─────────────────────────────────────────────────────────────────

  async getReports(scope: TenantScope, query: { from?: string; to?: string }) {
    await this.guard(scope, 'platform.revenue.view');

    const from = query.from ? new Date(query.from) : new Date(Date.now() - 30 * 86_400_000);
    const to   = query.to   ? new Date(query.to)   : new Date();
    to.setHours(23, 59, 59, 999);

    const [
      totalTenants,
      newTenants,
      totalMessages,
      inboundMessages,
      outboundMessages,
      totalCampaigns,
      completedCampaigns,
      totalContacts,
      newContacts,
      walletCredits,
      walletDebits,
      topTenantsByMessages,
    ] = await Promise.all([
      this.prisma.tenant.count(),
      this.prisma.tenant.count({ where: { createdAt: { gte: from, lte: to } } }),
      this.prisma.message.count({ where: { createdAt: { gte: from, lte: to } } }),
      this.prisma.message.count({ where: { createdAt: { gte: from, lte: to }, direction: 'INBOUND' } }),
      this.prisma.message.count({ where: { createdAt: { gte: from, lte: to }, direction: 'OUTBOUND' } }),
      this.prisma.campaign.count({ where: { createdAt: { gte: from, lte: to } } }),
      this.prisma.campaign.count({ where: { createdAt: { gte: from, lte: to }, status: 'COMPLETED' } }),
      this.prisma.contact.count(),
      this.prisma.contact.count({ where: { createdAt: { gte: from, lte: to } } }),
      this.prisma.walletTransaction.aggregate({
        where: { createdAt: { gte: from, lte: to }, type: { in: ['TOPUP', 'TRANSFER_IN', 'ADJUSTMENT', 'REFUND'] } },
        _sum:  { amountMinor: true },
      }),
      this.prisma.walletTransaction.aggregate({
        where: { createdAt: { gte: from, lte: to }, type: { in: ['DEBIT', 'TRANSFER_OUT'] } },
        _sum:  { amountMinor: true },
      }),
      this.prisma.message.groupBy({
        by:    ['tenantId'],
        where: { createdAt: { gte: from, lte: to } },
        _count: { _all: true },
        orderBy: { _count: { tenantId: 'desc' } },
        take:  10,
      }),
    ]);

    // Resolve tenant names for top list
    const topTenantIds   = topTenantsByMessages.map(r => r.tenantId).filter(Boolean) as string[];
    const tenantNameRows = await this.prisma.tenant.findMany({
      where:  { id: { in: topTenantIds } },
      select: { id: true, name: true, slug: true },
    });
    const tenantNameMap = new Map(tenantNameRows.map(t => [t.id, t]));

    const topTenants = topTenantsByMessages.map(r => ({
      tenantId:   r.tenantId,
      tenantName: tenantNameMap.get(r.tenantId ?? '')?.name ?? r.tenantId,
      slug:       tenantNameMap.get(r.tenantId ?? '')?.slug ?? '',
      messages:   r._count._all,
    }));

    // Daily message breakdown for the period
    const dailyRows = await this.prisma.$queryRaw<Array<{ date: string; count: bigint }>>`
      SELECT DATE("createdAt") AS date, COUNT(*) AS count
      FROM messages
      WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
      GROUP BY DATE("createdAt")
      ORDER BY date ASC
    `;
    const daily = dailyRows.map(r => ({ date: String(r.date).slice(0, 10), count: Number(r.count) }));

    return {
      success: true,
      data: {
        period: { from: from.toISOString(), to: to.toISOString() },
        tenants: { total: totalTenants, new: newTenants },
        messages: {
          total: totalMessages,
          inbound: inboundMessages,
          outbound: outboundMessages,
          daily,
        },
        campaigns: { total: totalCampaigns, completed: completedCampaigns },
        contacts:  { total: totalContacts, new: newContacts },
        wallet: {
          creditsMinor: walletCredits._sum.amountMinor ?? 0,
          debitsMinor:  walletDebits._sum.amountMinor  ?? 0,
        },
        topTenants,
      },
    };
  }

  async getReportsCsv(scope: TenantScope, query: { from?: string; to?: string }) {
    await this.guard(scope, 'platform.revenue.view');
    const result = await this.getReports(scope, query);
    const { data } = result;

    const rows: string[] = [
      '# Platform Report',
      `# Period: ${data.period.from.slice(0, 10)} to ${data.period.to.slice(0, 10)}`,
      '',
      '## Summary',
      'Metric,Value',
      `Total Tenants,${data.tenants.total}`,
      `New Tenants,${data.tenants.new}`,
      `Total Messages,${data.messages.total}`,
      `Inbound Messages,${data.messages.inbound}`,
      `Outbound Messages,${data.messages.outbound}`,
      `Total Campaigns,${data.campaigns.total}`,
      `Completed Campaigns,${data.campaigns.completed}`,
      `Total Contacts,${data.contacts.total}`,
      `New Contacts,${data.contacts.new}`,
      `Wallet Credits (paise),${data.wallet.creditsMinor}`,
      `Wallet Debits (paise),${data.wallet.debitsMinor}`,
      '',
      '## Daily Messages',
      'Date,Messages',
      ...data.messages.daily.map(d => `${d.date},${d.count}`),
      '',
      '## Top Tenants by Messages',
      'Tenant Name,Slug,Messages',
      ...data.topTenants.map(t => `"${t.tenantName}",${t.slug},${t.messages}`),
    ];

    return rows.join('\n');
  }

  // ── View-as ─────────────────────────────────────────────────────────────────

  /**
   * Opens someone else's account.
   *
   * Without `userId` the admin gets the account with their own Super Admin powers, which
   * is right for fixing something. With one, they become that person — their role, their
   * permissions, their name on anything they do — which is the only way to see what a
   * user is actually seeing when they report that something is missing.
   *
   * That second mode writes under someone else's name, so it is deliberately narrow: a
   * Super Admin is never impersonable, nor is the platform account, and both the start
   * and the end are recorded against the admin who did it.
   */
  async startViewAs(scope: TenantScope, tenantId: string, userId?: string) {
    await this.guard(scope, 'platform.impersonate');
    if (!tenantId) throw new BadRequestException('Choose an account');
    const tenant = await this.prisma.tenant.findUnique({
      where:  { id: tenantId },
      select: { id: true, slug: true, name: true, isActive: true, accountType: true, resellerType: true, parentId: true },
    });
    if (!tenant) throw new NotFoundException('Account not found');
    if (tenant.accountType === 'PLATFORM') {
      throw new BadRequestException("That's the platform account — use the admin panel");
    }
    if (!tenant.isActive) {
      throw new BadRequestException('This account is suspended. Activate it first to view it.');
    }

    let user: {
      id: string; name: string | null; email: string; role: string; permissions: string[];
    } | null = null;
    if (userId) {
      const row = await this.prisma.user.findFirst({
        where:  { id: userId, tenantId: tenant.id },
        select: { id: true, name: true, email: true, role: true, isActive: true, removedAt: true },
      });
      if (!row) throw new NotFoundException('That person is not in this account');
      if (!row.isActive || row.removedAt) {
        throw new BadRequestException('That account has been deactivated.');
      }
      // One Super Admin signing in as another would make the audit trail useless: there
      // would be no way to tell which of them did what.
      if (row.role === 'SUPER_ADMIN') {
        throw new BadRequestException('A Super Admin cannot be signed in as.');
      }
      // Their effective permissions travel in the signed cookie rather than being looked
      // up per request. Within its two hours a permission change will not be reflected —
      // the server still refuses what it should, so the cost is a menu item that does
      // nothing, not access anyone should not have.
      user = {
        id: row.id, name: row.name, email: row.email, role: row.role,
        permissions: await this.permissions.list(row.id),
      };
    }

    await this.prisma.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        userId:   scope.userId,
        action:   user ? 'ADMIN_IMPERSONATION_STARTED' : 'ADMIN_VIEW_AS_STARTED',
        resource: user ? 'user' : 'tenant',
        resourceId: user?.id ?? tenant.id,
        metadata: user
          ? { tenantName: tenant.name, userName: user.name, userEmail: user.email, userRole: user.role }
          : { tenantName: tenant.name },
      },
    });

    return {
      success: true,
      data: {
        tenantId:       tenant.id,
        tenantSlug:     tenant.slug,
        tenantName:     tenant.name,
        accountType:    tenant.accountType,
        resellerType:   tenant.resellerType,
        parentTenantId: tenant.parentId,
        user,
        redirect:       tenant.accountType === 'RESELLER' ? '/reseller' : '/inbox',
      },
    };
  }

  /** Everyone in an account who can be signed in as. */
  async listTenantUsers(scope: TenantScope, tenantId: string) {
    await this.guard(scope, 'platform.impersonate');
    const users = await this.prisma.user.findMany({
      where:  { tenantId, isActive: true, removedAt: null, role: { not: 'SUPER_ADMIN' } },
      select: { id: true, name: true, email: true, role: true, lastLoginAt: true },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });
    return { users, total: users.length };
  }

  async stopViewAs(scope: TenantScope) {
    await this.guard(scope, 'platform.impersonate');
    await this.prisma.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        userId:   scope.userId,
        action:   'ADMIN_VIEW_AS_ENDED',
        resource: 'tenant',
      },
    });
    return { success: true, data: { redirect: '/tenants' } };
  }

  // ── Platform staff ───────────────────────────────────────────────────────────

  /**
   * The people who help run the platform.
   *
   * They live on the platform account like any other user, so everything that already
   * understands users — sessions, audit rows, the permission resolver — understands them
   * too. What makes them staff is only where they live and what they have been granted.
   *
   * The Super Admin is not among them: there is one, it is the account's owner, and
   * nobody may create or edit another through here.
   */
  async listStaff(scope: TenantScope) {
    await this.guard(scope, 'platform.staff.manage');
    const users = await this.prisma.user.findMany({
      where:  { tenantId: scope.tenantId, role: { not: 'SUPER_ADMIN' as any } },
      select: {
        id: true, name: true, email: true, role: true, isActive: true,
        lastLoginAt: true, createdAt: true, removedAt: true,
        userPermissions: { select: { permission: true, allowed: true } },
      },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    });
    return {
      staff: users.map((u) => ({
        id: u.id, name: u.name, email: u.email, role: u.role,
        isActive: u.isActive && !u.removedAt,
        lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
        grantedCount: u.userPermissions.filter((x) => x.allowed).length,
      })),
      total: users.length,
    };
  }

  async createStaff(
    scope: TenantScope,
    body: { name?: string; email?: string; password?: string; role?: string },
  ) {
    await this.guard(scope, 'platform.staff.manage');
    requireFields(body, ['name', 'email', 'password']);
    const email = String(body.email).trim().toLowerCase();
    const role  = (body.role ?? 'ADMIN').toUpperCase();

    // A second Super Admin would be indistinguishable from the first in every record.
    if (role === 'SUPER_ADMIN' || !isInvitableRole(role)) {
      throw new BadRequestException('Choose Admin, Manager, Marketing or Agent.');
    }
    if (String(body.password).length < 8) {
      throw new BadRequestException('Use a password of at least 8 characters.');
    }
    const clash = await this.prisma.user.findFirst({
      where:  { email, tenantId: scope.tenantId },
      select: { id: true },
    });
    if (clash) throw new ConflictException('Someone with that email is already here.');

    const user = await this.prisma.user.create({
      data: {
        tenantId: scope.tenantId,
        name:     String(body.name).trim(),
        email,
        password: await bcrypt.hash(String(body.password), 10),
        role:     role as any,
        isActive: true,
        emailVerified: true,
      },
      select: { id: true, name: true, email: true, role: true },
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: scope.tenantId, userId: scope.userId,
        action: 'ADMIN_STAFF_CREATED', resource: 'user', resourceId: user.id,
        metadata: { email: user.email, role: user.role },
      },
    });
    // They begin able to see the platform and change nothing in it; each power is handed
    // over deliberately from the permissions screen.
    return { success: true, data: user };
  }

  async updateStaff(
    scope: TenantScope,
    id: string,
    body: { name?: string; role?: string; isActive?: boolean },
  ) {
    await this.guard(scope, 'platform.staff.manage');
    const member = await this.staffMember(scope, id);
    if (member.id === scope.userId && body.isActive === false) {
      throw new BadRequestException('You cannot deactivate yourself.');
    }
    if (body.role !== undefined) {
      const role = String(body.role).toUpperCase();
      if (!isInvitableRole(role)) throw new BadRequestException('Choose Admin, Manager, Marketing or Agent.');
      body = { ...body, role };
    }

    const updated = await this.prisma.user.update({
      where: { id: member.id },
      data: {
        ...(body.name !== undefined     && { name: String(body.name).trim() }),
        ...(body.role !== undefined     && { role: body.role as any }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
      },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: scope.tenantId, userId: scope.userId,
        action: 'ADMIN_STAFF_UPDATED', resource: 'user', resourceId: member.id,
        metadata: { ...body },
      },
    });
    this.permissions.invalidate(member.id);
    return { success: true, data: updated };
  }

  /** What this person may do, and which of it came from their role rather than a grant. */
  async getStaffPermissions(scope: TenantScope, id: string) {
    await this.guard(scope, 'platform.staff.manage');
    const member = await this.staffMember(scope, id);
    const overrides = new Map(
      (await this.prisma.userPermission.findMany({
        where:  { userId: member.id },
        select: { permission: true, allowed: true },
      })).map((p) => [p.permission, p.allowed]),
    );
    const principal = { role: member.role, accountType: 'PLATFORM', resellerType: null };

    const result: Record<string, { roleDefault: boolean; override: boolean | null; effective: boolean }> = {};
    for (const p of PLATFORM_PERMISSIONS) {
      result[p] = {
        roleDefault: (roleDefaults(member.role, 'PLATFORM') as readonly string[]).includes(p),
        override:    overrides.has(p) ? overrides.get(p)! : null,
        effective:   resolvePermission(principal, p as Permission, new Map(), overrides),
      };
    }
    return { role: member.role, permissions: result };
  }

  async setStaffPermissions(scope: TenantScope, id: string, overrides: Record<string, boolean | null>) {
    await this.guard(scope, 'platform.staff.manage');
    const member = await this.staffMember(scope, id);
    // Editing your own would let you remove the power to put it back, leaving nobody but
    // the Super Admin able to undo it.
    if (member.id === scope.userId) {
      throw new BadRequestException('Ask the Super Admin to change your own access.');
    }

    const valid = new Set<string>(PLATFORM_PERMISSIONS);
    await this.prisma.$transaction(async (tx) => {
      for (const [perm, value] of Object.entries(overrides)) {
        if (!valid.has(perm)) continue;
        if (value === null) {
          await tx.userPermission.deleteMany({ where: { userId: member.id, permission: perm } });
        } else {
          await tx.userPermission.upsert({
            where:  { userId_permission: { userId: member.id, permission: perm } },
            create: { userId: member.id, permission: perm, allowed: value },
            update: { allowed: value },
          });
        }
      }
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: scope.tenantId, userId: scope.userId,
        action: 'ADMIN_STAFF_PERMISSIONS_CHANGED', resource: 'user', resourceId: member.id,
        metadata: { overrides },
      },
    });
    // So it bites on their very next request rather than after the cache expires.
    this.permissions.invalidate(member.id);
    return { success: true };
  }

  private async staffMember(scope: TenantScope, id: string) {
    const member = await this.prisma.user.findFirst({
      where:  { id, tenantId: scope.tenantId, role: { not: 'SUPER_ADMIN' as any } },
      select: { id: true, role: true, email: true },
    });
    if (!member) throw new NotFoundException('That person is not on your team');
    return member;
  }

  // ── White-label ──────────────────────────────────────────────────────────────

  async getWhiteLabel(scope: TenantScope) {
    await this.guard(scope, 'platform.whitelabel.manage');
    const [config, resellers] = await Promise.all([
      (this.prisma as any).platformConfig.findUnique({ where: { id: 'platform' } }),
      this.prisma.tenant.findMany({
        where:   { accountType: 'RESELLER', resellerType: 'WHITE_LABEL' },
        select:  {
          id: true, name: true, isActive: true,
          whiteLabel: { select: { brandName: true, domain: true, subdomain: true, isActive: true } },
          wallet:     { select: { balanceMinor: true } },
          _count:     { select: { children: true } },
        },
        orderBy: { name: 'asc' },
      }),
    ]);

    const tenantIds = resellers.map((r: any) => r.id);
    const wlcList = tenantIds.length
      ? await (this.prisma as any).whiteLabelConfig.findMany({
          where:  { tenantId: { in: tenantIds } },
          select: { tenantId: true, feeOverrideMinor: true, feeDueSince: true, suspendedAt: true, suspendedReason: true },
        })
      : [];
    const wlcMap = new Map((wlcList as any[]).map((w: any) => [w.tenantId, w]));

    const platFeeMinor = config?.whiteLabelFeeMinor ?? 0;

    const rows = resellers.map((r: any) => {
      const wlc = wlcMap.get(r.id) ?? null;
      const feeMinor = wlc?.feeOverrideMinor !== null && wlc?.feeOverrideMinor !== undefined
        ? wlc.feeOverrideMinor
        : platFeeMinor;
      return {
        id:          r.id,
        name:        r.name,
        isActive:    r.isActive,
        clients:     r._count.children,
        brand:       r.whiteLabel ?? null,
        walletMinor: Math.max(0, r.wallet?.balanceMinor ?? 0),
        fee: wlc ? {
          feeMinor,
          isOverride:      wlc.feeOverrideMinor !== null && wlc.feeOverrideMinor !== undefined,
          paid:            wlc.feeDueSince === null,
          dueSince:        wlc.feeDueSince ? (wlc.feeDueSince as Date).toISOString() : null,
          suspended:       wlc.suspendedAt !== null,
          suspendedReason: wlc.suspendedReason ?? null,
        } : null,
      };
    });

    return {
      success: true,
      data: {
        rootDomain: process.env.PLATFORM_ROOT_DOMAIN ?? null,
        config: {
          whiteLabelFeeMinor:  config?.whiteLabelFeeMinor  ?? 0,
          whiteLabelGraceDays: config?.whiteLabelGraceDays ?? 7,
        },
        resellers: rows,
      },
    };
  }

  async updateWhiteLabel(scope: TenantScope, data: { whiteLabelFeeMinor?: number; whiteLabelGraceDays?: number }) {
    await this.guard(scope, 'platform.whitelabel.manage');
    const updated = await (this.prisma as any).platformConfig.upsert({
      where:  { id: 'platform' },
      create: { id: 'platform', ...data },
      update: data,
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        userId:   scope.userId,
        action:   'WHITE_LABEL_FEE_SETTINGS',
        resource: 'platform_config',
        metadata: data,
      },
    });
    return { success: true, data: updated };
  }

  async patchTenantWhiteLabel(
    scope: TenantScope,
    tenantId: string,
    data: {
      action?: string; feeOverrideMinor?: number | null; reason?: string;
      domain?: string | null; subdomain?: string | null;
    },
  ) {
    await this.guard(scope, 'platform.tenants.manage');

    let outcome = 'updated';

    // Where the brand answers. A reseller sets this on its own Branding page, but an
    // operator setting up an account, or fixing a mistyped domain for someone who cannot,
    // had no way to do it at all — the admin table showed the address and nothing more.
    if (data.domain !== undefined || data.subdomain !== undefined) {
      const domain    = data.domain?.trim().toLowerCase()    || null;
      const subdomain = data.subdomain?.trim().toLowerCase() || null;

      // Both are unique across the platform, so a clash has to be refused rather than
      // let through to a constraint error that says nothing useful.
      for (const [field, value] of [['domain', domain], ['subdomain', subdomain]] as const) {
        if (!value) continue;
        const taken = await (this.prisma as any).whiteLabelConfig.findFirst({
          where:  { [field]: value, tenantId: { not: tenantId } },
          select: { tenantId: true },
        });
        if (taken) throw new BadRequestException(`That ${field} is already used by another reseller.`);
      }

      await (this.prisma as any).whiteLabelConfig.update({
        where: { tenantId },
        data:  {
          ...(data.domain    !== undefined && { domain }),
          ...(data.subdomain !== undefined && { subdomain }),
        },
      });
      outcome = 'address_set';
    }

    if (data.feeOverrideMinor !== undefined) {
      await (this.prisma as any).whiteLabelConfig.update({
        where: { tenantId },
        data:  { feeOverrideMinor: data.feeOverrideMinor },
      });
      outcome = 'fee_override_set';
    }

    if (data.action === 'charge') {
      const wlConfig   = await (this.prisma as any).whiteLabelConfig.findUnique({ where: { tenantId } });
      const platConfig = await (this.prisma as any).platformConfig.findUnique({ where: { id: 'platform' } });
      const feeMinor   = (wlConfig?.feeOverrideMinor as number | null | undefined) ?? (platConfig?.whiteLabelFeeMinor as number | undefined) ?? 0;
      if (feeMinor > 0) {
        const movement = await this.wallet.debit(tenantId, feeMinor, {
          description:   'White-label monthly fee',
          referenceType: 'white_label_fee',
          createdById:   scope.userId,
        });
        outcome = movement.shortfallMinor > 0
          ? `charged_${Math.abs(movement.appliedMinor)}_short_${movement.shortfallMinor}`
          : `charged_${feeMinor}`;
      } else {
        outcome = 'no_fee_configured';
      }
    }

    if (data.action === 'suspend') {
      await (this.prisma as any).whiteLabelConfig.update({
        where: { tenantId },
        data:  { suspendedAt: new Date(), suspendedReason: data.reason || 'Suspended by the platform' },
      });
      outcome = 'suspended';
    }

    if (data.action === 'reactivate') {
      await (this.prisma as any).whiteLabelConfig.update({
        where: { tenantId },
        data:  { suspendedAt: null, suspendedReason: null, feeDueSince: null },
      });
      outcome = 'reactivated';
    }

    await this.prisma.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        userId:   scope.userId,
        action:   'ADMIN_PATCH_WHITE_LABEL',
        resource: `tenant:${tenantId}`,
        metadata: data as any,
      },
    });
    return { success: true, data: { outcome } };
  }

  // ── CMS helpers ──────────────────────────────────────────────────────────────

  /**
   * Whose homepage this request edits.
   *
   * A super admin edits the platform's own site, which has no tenant. A white-label
   * reseller edits its brand's copy, scoped to its tenant. Both use the same editor and
   * the same sections; only the row they land in differs.
   */
  private cmsOwner(scope: TenantScope): string | null {
    return scope.role === 'SUPER_ADMIN' ? null : scope.tenantId;
  }

  private buildEditorSection(
    key: string,
    section: null | { isActive: boolean; content: unknown; itemKinds?: string[]; items?: any[]; updatedAt?: Date },
  ): { key: string; isActive: boolean; content: Record<string, unknown>; items: Record<string, any[]>; source: string; updatedAt: string | null } {
    const meta = CMS_SECTIONS_META[key];
    const collections: string[] = meta?.collections ?? [];

    const items: Record<string, any[]> = {};
    for (const kind of collections) {
      items[kind] = [];
    }
    for (const item of (section?.items ?? []) as any[]) {
      if (!(item.kind in items)) items[item.kind] = [];
      items[item.kind].push({ id: item.id, isActive: item.isActive, data: (item.data as Record<string, unknown>) ?? {} });
    }

    return {
      key,
      isActive: section?.isActive ?? true,
      content: (section?.content as Record<string, unknown>) ?? {},
      items,
      source: section ? 'saved' : 'default',
      updatedAt: section?.updatedAt ? (section.updatedAt as Date).toISOString() : null,
    };
  }

  // ── CMS ──────────────────────────────────────────────────────────────────────

  async getCmsNewsletter(scope: TenantScope) {
    await this.guard(scope, 'platform.cms.manage');
    const [total, recent] = await Promise.all([
      this.prisma.newsletterSubscriber.count(),
      this.prisma.newsletterSubscriber.findMany({
        orderBy: { createdAt: 'desc' },
        take:    50,
        select:  { id: true, email: true, source: true, createdAt: true },
      }),
    ]);
    return { success: true, data: { total, recent } };
  }

  async getCmsSections(scope: TenantScope) {
    await this.guardCms(scope);
    const storedSections = await (this.prisma as any).cmsSection.findMany({
      where:   { tenantId: this.cmsOwner(scope), page: 'home' },
      include: { items: { select: { isActive: true } } },
    });
    const sectionMap = new Map<string, any>(storedSections.map((s: any) => [s.key, s]));

    const data = CMS_SECTION_KEYS.map((key) => {
      const meta    = CMS_SECTIONS_META[key];
      const section = sectionMap.get(key);
      const items   = (section?.items ?? []) as Array<{ isActive: boolean }>;
      return {
        key,
        label:           meta.label,
        description:     meta.description,
        whatsapp:        meta.whatsapp ?? false,
        isActive:        section?.isActive ?? true,
        source:          section ? 'saved' : 'default',
        updatedAt:       section?.updatedAt ? (section.updatedAt as Date).toISOString() : null,
        itemCount:       items.length,
        activeItemCount: items.filter((i) => i.isActive).length,
      };
    });

    return { success: true, data };
  }

  async getCmsSection(scope: TenantScope, key: string) {
    await this.guardCms(scope);
    const section = await (this.prisma as any).cmsSection.findFirst({
      where:   { tenantId: this.cmsOwner(scope), page: 'home', key },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    return { success: true, data: this.buildEditorSection(key, section) };
  }

  async updateCmsSection(scope: TenantScope, key: string, payload: any) {
    await this.guardCms(scope);
    const itemKinds = Object.keys((payload.items as Record<string, unknown>) ?? {});
    const owner     = this.cmsOwner(scope);
    const existing  = await (this.prisma as any).cmsSection.findFirst({ where: { tenantId: owner, page: 'home', key } });

    const section = existing
      ? await (this.prisma as any).cmsSection.update({
          where: { id: existing.id },
          data:  { isActive: payload.isActive, content: payload.content, itemKinds, updatedById: scope.userId },
        })
      : await (this.prisma as any).cmsSection.create({
          data: { tenantId: owner, page: 'home', key, isActive: payload.isActive ?? true, content: payload.content ?? {}, itemKinds, updatedById: scope.userId },
        });

    if (payload.items) {
      await (this.prisma as any).cmsItem.deleteMany({ where: { sectionId: section.id } });
      for (const [kind, list] of Object.entries(payload.items as Record<string, any[]>)) {
        for (const [i, item] of (list ?? []).entries()) {
          await (this.prisma as any).cmsItem.create({
            data: { sectionId: section.id, kind, sortOrder: i, isActive: item.isActive ?? true, data: item.data ?? {} },
          });
        }
      }
    }

    await this.prisma.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        userId:   scope.userId,
        action:   'CMS_SECTION_UPDATED',
        resource: 'cms_section',
        resourceId: key,
      },
    });

    const updated = await (this.prisma as any).cmsSection.findFirst({
      where:   { tenantId: owner, page: 'home', key },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    return { success: true, data: this.buildEditorSection(key, updated) };
  }

  async deleteCmsSection(scope: TenantScope, key: string) {
    await this.guardCms(scope);
    await (this.prisma as any).cmsSection.deleteMany({ where: { tenantId: this.cmsOwner(scope), page: 'home', key } });
    await this.prisma.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        userId:   scope.userId,
        action:   'CMS_SECTION_RESET',
        resource: 'cms_section',
        resourceId: key,
      },
    });
    return { success: true, data: this.buildEditorSection(key, null) };
  }

  // ── Commissions ──────────────────────────────────────────────────────────────

  async listCommissions(
    scope: TenantScope,
    query: { status?: string; resellerId?: string; page?: number; limit?: number },
  ) {
    await this.guard(scope, 'platform.revenue.view');
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 50);
    const where: any = {};
    if (query.status)     where.status     = query.status;
    if (query.resellerId) where.resellerId = query.resellerId;

    const [total, rows, totals] = await Promise.all([
      (this.prisma as any).resellerCommission.count({ where }),
      (this.prisma as any).resellerCommission.findMany({
        where,
        select: {
          id: true, baseMinor: true, amountMinor: true, rate: true, currency: true,
          status: true, createdAt: true, paidAt: true, note: true,
          reseller: { select: { id: true, name: true } },
          client:   { select: { id: true, name: true } },
          payment:  { select: { provider: true, providerPaymentId: true, purpose: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip:    (page - 1) * limit,
        take:    limit,
      }),
      (this.prisma as any).resellerCommission.groupBy({
        by: ['status'],
        where: query.resellerId ? { resellerId: query.resellerId } : {},
        _sum: { amountMinor: true },
      }),
    ]);

    return {
      success: true,
      data:   rows,
      totals: Object.fromEntries((totals as any[]).map((t) => [t.status, t._sum.amountMinor ?? 0])),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ── Platform permissions matrix ───────────────────────────────────────────────

  async getPermissionsMatrix(scope: TenantScope) {
    await this.guard(scope, 'platform.staff.manage');
    const rows = await (this.prisma as any).rolePermission.findMany();
    const overrideMap = new Map((rows as any[]).map((r) => [`${r.accountType}:${r.role}:${r.permission}`, r.allowed]));

    const ACCOUNT_TYPES = ['CLIENT', 'RESELLER'] as const;
    const ROLES = ['TENANT_OWNER', 'ADMIN', 'MANAGER', 'MARKETING_USER', 'AGENT'] as const;

    const matrix = ACCOUNT_TYPES.map((accountType) => {
      const resellerType = accountType === 'RESELLER' ? 'WHITE_LABEL' : null;
      const ceiling = accountCeiling(accountType, resellerType);
      return {
        accountType,
        roles: ROLES.map((role) => ({
          role,
          permissions: PERMISSIONS.map((permission) => ({
            permission,
            available:  (ceiling as readonly string[]).includes(permission),
            byDefault:  (roleDefaults(role) as readonly string[]).includes(permission),
            override:   overrideMap.get(`${accountType}:${role}:${permission}`) ?? null,
            effective:  resolvePermission({ role, accountType, resellerType }, permission, overrideMap),
          })),
        })),
      };
    });

    return { success: true, data: { permissions: PERMISSIONS, matrix } };
  }

  async setPermissionOverride(
    scope: TenantScope,
    data: { accountType: string; role: string; permission: string; allowed: boolean | null },
  ) {
    await this.guard(scope, 'platform.staff.manage');
    const { accountType, role, permission, allowed } = data;
    if (!PERMISSIONS.includes(permission as any)) {
      throw new BadRequestException('Unknown permission');
    }
    if (allowed && !(accountCeiling(accountType, 'WHITE_LABEL') as readonly string[]).includes(permission)) {
      throw new BadRequestException(`${permission} can never be granted to ${accountType.toLowerCase()} accounts`);
    }

    if (allowed === null) {
      await (this.prisma as any).rolePermission.deleteMany({ where: { accountType, role, permission } });
    } else {
      await (this.prisma as any).rolePermission.upsert({
        where:  { accountType_role_permission: { accountType, role, permission } },
        create: { accountType, role, permission, allowed },
        update: { allowed },
      });
    }
    await this.prisma.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        userId:   scope.userId,
        action:   'PERMISSION_CHANGED',
        resource: 'role_permission',
        resourceId: `${accountType}:${role}:${permission}`,
        metadata: { allowed },
      },
    });
    return { success: true };
  }

  // ── Tenant Subscription ───────────────────────────────────────────────────────

  async getTenantSubscription(scope: TenantScope, tenantId: string) {
    await this.guard(scope, 'platform.tenants.view');
    const sub = await this.prisma.subscription.findUnique({
      where: { tenantId },
      include: { plan: true },
    });
    if (!sub) return null;
    const [contacts, users] = await Promise.all([
      this.prisma.contact.count({ where: { tenantId } }),
      this.prisma.user.count({ where: { tenantId } }),
    ]);
    return { ...sub, usage: { contacts, users } };
  }

  /**
   * The super admin's override of a tenant's subscription.
   *
   * Every field the admin form offers is applied. It used to accept only the plan, the
   * status and the period end while the form also sent the billing cycle, the period
   * start, the trial end and a reset-usage flag — those four were dropped in silence, so
   * extending somebody's trial appeared to work and changed nothing. A control that
   * reports success without acting is worse than one that is not there.
   *
   * `trialEndsAt` is deliberately nullable rather than optional: clearing the date is how
   * a trial is ended early, so `null` has to reach the database instead of being skipped
   * the way an absent field is.
   */
  /** The platform's policy row, created on first read so there is always one to edit. */
  private async platformSettings() {
    const platform = await this.prisma.tenant.findFirst({
      where:  { accountType: 'PLATFORM' },
      select: { id: true },
    });
    if (!platform) throw new NotFoundException('No platform account exists');
    return this.prisma.tenantSettings.upsert({
      where:  { tenantId: platform.id },
      create: { tenantId: platform.id },
      update: {},
    });
  }

  /**
   * Moves every platform message rate, and optionally every plan price, in one go.
   *
   * Always previewable and never silent: `dryRun` returns exactly what would change so
   * the whole set can be read before anything is written. A sweeping price change is the
   * sort of thing people want to look at twice.
   */
  async bulkPriceChange(
    scope: TenantScope,
    body: BulkPriceChange & { target?: 'rates' | 'plans' | 'both' },
  ) {
    await this.guard(scope, 'platform.pricing.manage');
    const target = body.target ?? 'rates';

    const rates = target === 'plans' ? [] : await this.prisma.messageRate.findMany({
      where:  { resellerId: null, tenantId: null },
      select: { id: true, category: true, priceMinor: true },
    });
    const plans = target === 'rates' ? [] : await this.prisma.plan.findMany({
      select: { id: true, displayName: true, priceMonthly: true, priceAnnual: true },
    });

    const rateLines = computeBulkPrices(
      rates.map((r) => ({ id: r.id, label: r.category, priceMinor: r.priceMinor })), body,
    );
    const monthlyLines = computeBulkPrices(
      plans.map((p) => ({ id: p.id, label: `${p.displayName} (monthly)`, priceMinor: Number(p.priceMonthly) })), body,
    );
    const annualLines = computeBulkPrices(
      plans.map((p) => ({ id: p.id, label: `${p.displayName} (annual)`, priceMinor: Number(p.priceAnnual) })), body,
    );

    if (body.dryRun) {
      return { applied: false, rates: rateLines, plansMonthly: monthlyLines, plansAnnual: annualLines };
    }

    await this.prisma.$transaction([
      ...rateLines.map((l) =>
        this.prisma.messageRate.update({ where: { id: l.id }, data: { priceMinor: l.after } })),
      ...plans.map((p, i) =>
        this.prisma.plan.update({
          where: { id: p.id },
          data:  { priceMonthly: monthlyLines[i].after, priceAnnual: annualLines[i].after },
        })),
    ]);

    return {
      applied: true,
      changed: rateLines.length + plans.length,
      rates: rateLines, plansMonthly: monthlyLines, plansAnnual: annualLines,
    };
  }

  async getPlanEndPolicy(scope: TenantScope) {
    await this.guard(scope, 'platform.pricing.manage');
    const settings = await this.platformSettings();
    return {
      behaviour: settings.planEndBehaviour,
      graceDays: settings.planEndGraceDays,
      walletEnabled: settings.walletEnabled,
      options: [
        { value: 'GRACE', label: 'Keep working for a grace period, then stop',
          detail: 'The default. Most people renew in the first few days after lapsing.' },
        { value: 'BLOCK', label: 'Stop paid features immediately',
          detail: 'Strictest. Sign-in and existing conversations still work.' },
        { value: 'AUTO_CHARGE', label: 'Charge automatically',
          detail: 'Needs recurring billing, which is not set up yet. Behaves as grace until it is.' },
      ],
    };
  }

  async setPlanEndPolicy(
    scope: TenantScope,
    body: { behaviour?: string; graceDays?: number; walletEnabled?: boolean },
  ) {
    await this.guard(scope, 'platform.pricing.manage');
    const allowed = ['GRACE', 'BLOCK', 'AUTO_CHARGE'];
    if (body.behaviour && !allowed.includes(body.behaviour)) {
      throw new BadRequestException(`behaviour must be one of ${allowed.join(', ')}.`);
    }
    if (body.graceDays !== undefined && (body.graceDays < 0 || body.graceDays > 90)) {
      throw new BadRequestException('graceDays must be between 0 and 90.');
    }

    const settings = await this.platformSettings();
    const saved = await this.prisma.tenantSettings.update({
      where: { tenantId: settings.tenantId },
      data:  {
        ...(body.behaviour ? { planEndBehaviour: body.behaviour } : {}),
        ...(body.graceDays !== undefined ? { planEndGraceDays: body.graceDays } : {}),
        ...(body.walletEnabled !== undefined ? { walletEnabled: body.walletEnabled } : {}),
      },
    });
    return {
      behaviour: saved.planEndBehaviour,
      graceDays: saved.planEndGraceDays,
      walletEnabled: saved.walletEnabled,
    };
  }

  async updateTenantSubscription(
    scope: TenantScope,
    tenantId: string,
    data: {
      planId?: string;
      status?: string;
      billingCycle?: string;
      currentPeriodStart?: string;
      currentPeriodEnd?: string;
      trialEndsAt?: string | null;
      resetUsage?: boolean;
    },
  ) {
    await this.guard(scope, 'platform.tenants.manage');

    const sub = await this.prisma.subscription.upsert({
      where: { tenantId },
      create: {
        tenantId,
        planId: data.planId ?? 'free',
        status: (data.status ?? 'ACTIVE') as any,
        ...(data.billingCycle ? { billingCycle: data.billingCycle as any } : {}),
        currentPeriodStart: data.currentPeriodStart ? new Date(data.currentPeriodStart) : new Date(),
        currentPeriodEnd: data.currentPeriodEnd ? new Date(data.currentPeriodEnd) : new Date(Date.now() + 30 * 86400000),
        ...(data.trialEndsAt ? { trialEndsAt: new Date(data.trialEndsAt) } : {}),
      },
      update: {
        ...(data.planId ? { planId: data.planId } : {}),
        ...(data.status ? { status: data.status as any } : {}),
        ...(data.billingCycle ? { billingCycle: data.billingCycle as any } : {}),
        ...(data.currentPeriodStart ? { currentPeriodStart: new Date(data.currentPeriodStart) } : {}),
        ...(data.currentPeriodEnd ? { currentPeriodEnd: new Date(data.currentPeriodEnd) } : {}),
        ...(data.trialEndsAt !== undefined
          ? { trialEndsAt: data.trialEndsAt ? new Date(data.trialEndsAt) : null }
          : {}),
        ...(data.resetUsage ? { aiCreditsUsed: 0 } : {}),
      },
    });

    // The plan guard caches its per-tenant snapshot for a minute and each module holds
    // its own instance, so there is no one cache to clear from here. An override can
    // therefore take up to a minute to be felt on the feature routes; the billing pages
    // read the database directly and show it at once.
    return sub;
  }

  // ── Tenant WhatsApp ───────────────────────────────────────────────────────────

  /**
   * A tenant's WhatsApp setup, grouped the way it is actually organised: per business,
   * each with its connected numbers, whatever is still stored at business level from
   * before numbers were their own rows, and how its templates stand with Meta.
   *
   * The secrets themselves are deliberately absent. This used to return whole
   * integration rows, which put the encrypted token and app secret into the browser of
   * anyone with the page open — useless to read, and one copied response away from being
   * somewhere it should not be. A token is handed over only by asking, through
   * `revealWhatsAppToken`, which records who asked.
   */
  async getTenantWhatsApp(scope: TenantScope, tenantId: string) {
    await this.guard(scope, 'platform.tenants.view');

    const businesses = await this.prisma.business.findMany({
      where:   { tenantId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, name: true,
        whatsappPhoneNumber: true, whatsappPhoneNumberId: true,
        whatsappBusinessId: true, whatsappAccessToken: true,
      },
    });
    const businessIds = businesses.map((b) => b.id);

    const [numbers, templateCounts, conversationCounts, lastMessages] = await Promise.all([
      this.prisma.whatsAppIntegration.findMany({
        where:   { businessId: { in: businessIds } },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      }),
      this.prisma.messageTemplate.groupBy({
        by: ['businessId', 'status'],
        where: { businessId: { in: businessIds } },
        _count: { _all: true },
      }),
      this.prisma.conversation.groupBy({
        by: ['whatsappIntegrationId'],
        where: { businessId: { in: businessIds } },
        _count: { _all: true },
      }),
      this.prisma.conversation.groupBy({
        by: ['whatsappIntegrationId'],
        where: { businessId: { in: businessIds } },
        _max: { lastMessageAt: true },
      }),
    ]);

    const chats = new Map(conversationCounts.map((c) => [c.whatsappIntegrationId, c._count._all]));
    const lastAt = new Map(lastMessages.map((c) => [c.whatsappIntegrationId, c._max.lastMessageAt]));

    return {
      businesses: businesses.map((b) => {
        const statuses = templateCounts.filter((t) => t.businessId === b.id);
        const of = (...want: string[]) =>
          statuses.filter((t) => want.includes(t.status)).reduce((n, t) => n + t._count._all, 0);

        return {
          id:   b.id,
          name: b.name,
          numbers: numbers.filter((n) => n.businessId === b.id).map((n) => {
            const token = decryptSecret(n.accessToken ?? '');
            return {
              id:                     n.id,
              displayName:            n.displayName,
              phoneNumber:            n.phoneNumber,
              phoneNumberId:          n.phoneNumberId,
              whatsappBusinessId:     n.whatsappBusinessId,
              qualityRating:          n.qualityRating,
              codeVerificationStatus: n.codeVerificationStatus,
              isActive:               n.isActive,
              isDefault:              n.isDefault,
              createdAt:              n.createdAt,
              conversations:          chats.get(n.id) ?? 0,
              lastMessageAt:          lastAt.get(n.id) ?? null,
              // Enough to tell two tokens apart in a support conversation, not enough to
              // use. A stored token that will not decrypt usually means ENCRYPTION_KEY
              // changed, which is worth showing rather than reading as "no token".
              hasToken:      Boolean(n.accessToken),
              tokenReadable: Boolean(token),
              tokenHint:     token ? `…${token.slice(-6)}` : null,
              hasAppSecret:  Boolean(n.appSecret),
            };
          }),
          // Credentials from before each number had its own row. Still used as a
          // fallback at send time, so an operator needs to know they are there.
          legacy: b.whatsappPhoneNumberId
            ? {
                phoneNumber:        b.whatsappPhoneNumber,
                phoneNumberId:      b.whatsappPhoneNumberId,
                whatsappBusinessId: b.whatsappBusinessId,
                hasToken:           Boolean(b.whatsappAccessToken),
              }
            : null,
          templates: {
            approved: of('APPROVED'),
            inReview: of('PENDING', 'SUBMITTED'),
            other:    of('DRAFT', 'REJECTED', 'DISABLED'),
          },
        };
      }),
      // Nothing is configured platform-wide per tenant; the field is kept so the panel
      // can say so rather than guess.
      accountSettings: null,
    };
  }

  /**
   * Hands over one access token, and writes down who asked for it.
   *
   * Reading a customer's credential is sometimes the only way to tell them why Meta is
   * refusing their messages, but it is still reading a customer's credential — so it is
   * a separate, deliberate request rather than a field on a page, and it leaves a trail.
   */
  async revealWhatsAppToken(scope: TenantScope, tenantId: string, integrationId: string) {
    await this.guard(scope, 'platform.secrets.reveal');
    const row = await this.prisma.whatsAppIntegration.findFirst({
      where:  { id: integrationId, tenantId },
      select: { id: true, accessToken: true, displayName: true, phoneNumberId: true },
    });
    if (!row) throw new NotFoundException('That WhatsApp number is not on this account');

    const token = decryptSecret(row.accessToken ?? '');
    if (!token) {
      throw new NotFoundException('This token cannot be read — it may predate the current encryption key');
    }

    await this.prisma.auditLog.create({
      data: {
        tenantId:   scope.tenantId,
        userId:     scope.userId,
        action:     'WHATSAPP_TOKEN_REVEALED',
        resource:   'whatsAppIntegration',
        resourceId: row.id,
        metadata:   { ofTenantId: tenantId, phoneNumberId: row.phoneNumberId, number: row.displayName },
      },
    });

    return { token };
  }

  async adminWhatsAppAction(scope: TenantScope, tenantId: string, action: string) {
    await this.guard(scope, 'platform.tenants.manage');
    if (action === 'disconnect') {
      await this.prisma.whatsAppIntegration.updateMany({
        where: { tenantId },
        data:  { isActive: false },
      });
      return { ok: true, action, disconnected: true };
    }
    return { ok: true, action };
  }

  // ── Commissions (update) ──────────────────────────────────────────────────────
  // Note: Prisma model is `resellerCommission` (no standalone `commission` model).

  async updateCommission(scope: TenantScope, id: string, data: { status: string; note?: string }) {
    await this.guard(scope, 'platform.commissions.manage');
    const existing = await this.prisma.resellerCommission.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Commission not found');
    const updated = await this.prisma.resellerCommission.update({
      where: { id },
      data:  {
        status: data.status as any,
        ...(data.note ? { note: data.note } : {}),
        ...(data.status === 'PAID' ? { paidAt: new Date() } : { paidAt: null }),
      },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId:   scope.tenantId,
        userId:     scope.userId,
        action:     'COMMISSION_UPDATED',
        resource:   'resellerCommission',
        resourceId: id,
        metadata:   { status: data.status, note: data.note ?? null },
      },
    });
    return { success: true, data: updated };
  }

  // ── Plans (deactivate) ────────────────────────────────────────────────────────

  async deactivatePlan(scope: TenantScope, id: string) {
    await this.guard(scope, 'platform.plans.manage');
    return this.prisma.plan.update({
      where: { id },
      data:  { isActive: false },
    });
  }

  // ── Health ────────────────────────────────────────────────────────────────────

  async getHealth() {
    const t0 = Date.now();
    let dbStatus: 'online' | 'error' = 'error';
    let dbLatencyMs = 0;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      dbLatencyMs = Date.now() - t0;
      dbStatus = 'online';
    } catch {
      dbLatencyMs = Date.now() - t0;
    }
    const apiLatencyMs = Date.now() - t0;

    const realtimeConfigured = Boolean(process.env['REDIS_HOST']);
    const waConfigured       = Boolean(process.env['WHATSAPP_APP_SECRET']);

    return {
      success: true,
      data: {
        api:      { latencyMs: apiLatencyMs, status: 'healthy' },
        database: { latencyMs: dbLatencyMs, status: dbStatus },
        realtime: { configured: realtimeConfigured, status: realtimeConfigured ? 'configured' : 'unconfigured' },
        whatsapp: { configured: waConfigured,        status: waConfigured       ? 'configured' : 'unconfigured' },
        checkedAt: new Date().toISOString(),
      },
    };
  }
}
