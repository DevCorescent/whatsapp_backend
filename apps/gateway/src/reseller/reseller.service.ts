import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';

@Injectable()
export class ResellerService {
  constructor(private readonly prisma: PrismaService) {}

  private async guardReseller(scope: TenantScope) {
    const tenant = await this.prisma.tenant.findUnique({
      where:  { id: scope.tenantId },
      select: { id: true, name: true, accountType: true, resellerType: true, commissionRate: true },
    });
    if (!tenant || tenant.accountType !== 'RESELLER') {
      throw new ForbiddenException('Reseller account only');
    }
    return tenant;
  }

  private generateTempPassword(): string {
    return crypto.randomBytes(8).toString('base64url').slice(0, 12);
  }

  private async uniqueSlug(base: string): Promise<string> {
    let slug = base || 'client';
    let n    = 0;
    while (await this.prisma.tenant.findFirst({ where: { slug }, select: { id: true } })) {
      slug = `${base}-${++n}`;
    }
    return slug;
  }

  // ── Overview ───────────────────────────────────────────────────────────────

  async getOverview(scope: TenantScope) {
    const tenant = await this.guardReseller(scope);

    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [clientsAll, pendingAgg, paidAgg, thisMonthAgg, ownerUser] = await Promise.all([
      this.prisma.tenant.findMany({
        where:  { parentId: scope.tenantId },
        select: { isActive: true, subscription: { select: { status: true } } },
      }),
      this.prisma.resellerCommission.aggregate({
        where: { resellerId: scope.tenantId, status: 'PENDING' },
        _sum:  { amountMinor: true },
      }),
      this.prisma.resellerCommission.aggregate({
        where: { resellerId: scope.tenantId, status: 'PAID' },
        _sum:  { amountMinor: true },
      }),
      this.prisma.resellerCommission.aggregate({
        where: { resellerId: scope.tenantId, createdAt: { gte: monthStart } },
        _sum:  { amountMinor: true },
      }),
      this.prisma.user.findFirst({
        where:  { tenantId: scope.tenantId, role: 'TENANT_OWNER' },
        select: { inviteCode: true },
      }),
    ]);

    const total    = clientsAll.length;
    const active   = (clientsAll as any[]).filter((c: any) => c.isActive && c.subscription?.status === 'ACTIVE').length;
    const trialing = (clientsAll as any[]).filter((c: any) => c.subscription?.status === 'TRIALING').length;

    const code    = ownerUser?.inviteCode ?? tenant.id.slice(-8);
    const baseUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    const link    = `${baseUrl}/register?ref=${code}`;

    const wl = tenant.resellerType === 'WHITE_LABEL';
    const permissions = [
      'reseller.clients.view',
      'reseller.commissions.view',
      'reseller.clients.manage',
      ...(wl ? ['reseller.branding.manage', 'reseller.plans.manage', 'reseller.rates.manage'] : []),
    ];

    return {
      account: {
        name:           tenant.name,
        resellerType:   tenant.resellerType as 'NORMAL' | 'WHITE_LABEL',
        commissionRate: tenant.commissionRate ?? null,
      },
      clients:    { total, active, trialing },
      commission: {
        pendingMinor:   (pendingAgg._sum as any).amountMinor ?? 0,
        paidMinor:      (paidAgg._sum as any).amountMinor   ?? 0,
        thisMonthMinor: (thisMonthAgg._sum as any).amountMinor ?? 0,
      },
      referral:    { code, link },
      permissions,
    };
  }

  // ── Branding ───────────────────────────────────────────────────────────────

  async getBranding(scope: TenantScope) {
    const tenant = await this.guardReseller(scope);

    const [config, platformCfg] = await Promise.all([
      (this.prisma as any).whiteLabelConfig.findUnique({ where: { tenantId: scope.tenantId } }),
      (this.prisma as any).platformConfig.findUnique({ where: { id: 'platform' } }).catch(() => null),
    ]);

    const rootDomain = process.env.PLATFORM_ROOT_DOMAIN ?? null;
    const feeMinor   = config?.feeOverrideMinor ?? platformCfg?.whiteLabelFeeMinor ?? 0;
    const graceDays  = platformCfg?.whiteLabelGraceDays ?? 7;
    const now        = new Date();
    const period     = now.toLocaleString('en-IN', { month: 'long', year: 'numeric' });

    let fee: any = null;
    if (tenant.resellerType === 'WHITE_LABEL') {
      fee = {
        period,
        feeMinor,
        paid:            !config?.feeDueSince,
        dueSince:        config?.feeDueSince ? (config.feeDueSince as Date).toISOString() : null,
        graceDays,
        suspended:       !!config?.suspendedAt,
        suspendedReason: config?.suspendedReason ?? null,
      };
    }

    const data = config ? {
      brandName:       config.brandName,
      logoUrl:         config.logoUrl,
      faviconUrl:      config.faviconUrl,
      primaryColor:    config.primaryColor,
      accentColor:     config.accentColor,
      domain:          config.domain,
      supportEmail:    config.supportEmail,
      supportPhone:    config.supportPhone,
      website:         config.website,
      address:         config.address,
      loginHeadline:   config.loginHeadline,
      loginSubtext:    config.loginSubtext,
      isActive:        config.isActive,
      subdomain:       config.subdomain,
      landingEnabled:  config.landingEnabled,
      landingTitle:    config.landingTitle,
      landingSubtitle: config.landingSubtitle,
      termsContent:    config.termsContent,
      privacyContent:  config.privacyContent,
    } : null;

    // Include success key so TransformInterceptor passes through unchanged,
    // letting rootDomain and fee appear at the top level of the response.
    return { success: true, data, rootDomain, fee };
  }

  async upsertBranding(scope: TenantScope, body: {
    brandName: string; logoUrl?: string; faviconUrl?: string; primaryColor?: string;
    accentColor?: string; domain?: string; supportEmail?: string; supportPhone?: string;
    website?: string; address?: string; loginHeadline?: string; loginSubtext?: string;
    subdomain?: string; landingEnabled?: boolean; landingTitle?: string; landingSubtitle?: string;
    termsContent?: string; privacyContent?: string;
  }) {
    await this.guardReseller(scope);

    const payload: any = {
      brandName:       body.brandName,
      logoUrl:         body.logoUrl        || null,
      faviconUrl:      body.faviconUrl     || null,
      primaryColor:    body.primaryColor   ?? '#059669',
      accentColor:     body.accentColor    || null,
      domain:          body.domain?.trim().toLowerCase() || null,
      supportEmail:    body.supportEmail   || null,
      supportPhone:    body.supportPhone   || null,
      website:         body.website        || null,
      address:         body.address        || null,
      loginHeadline:   body.loginHeadline  || null,
      loginSubtext:    body.loginSubtext   || null,
      subdomain:       body.subdomain?.trim().toLowerCase() || null,
      landingEnabled:  body.landingEnabled ?? true,
      landingTitle:    body.landingTitle   || null,
      landingSubtitle: body.landingSubtitle || null,
      termsContent:    body.termsContent   || null,
      privacyContent:  body.privacyContent || null,
    };

    if (payload.subdomain) {
      const taken = await (this.prisma as any).whiteLabelConfig.findFirst({
        where: { subdomain: payload.subdomain, tenantId: { not: scope.tenantId } },
        select: { id: true },
      });
      if (taken) throw new BadRequestException('This subdomain is already taken. Choose another.');
    }

    await (this.prisma as any).whiteLabelConfig.upsert({
      where:  { tenantId: scope.tenantId },
      create: { tenantId: scope.tenantId, ...payload },
      update: payload,
    });

    return {
      domainStatus: payload.domain
        ? { status: 'pending', message: 'Domain saved. Add the CNAME record pointing to cname.vercel-dns.com, then click Check now.' }
        : null,
    };
  }

  async checkDomainStatus(scope: TenantScope) {
    await this.guardReseller(scope);
    const config = await (this.prisma as any).whiteLabelConfig.findUnique({
      where:  { tenantId: scope.tenantId },
      select: { domain: true },
    });
    if (!config?.domain) return null;
    return {
      domain:  config.domain,
      state:   'not_added',
      message: 'Point a CNAME record for this domain at the value shown, then click Check now.',
      record:  { type: 'CNAME', name: config.domain, value: 'cname.vercel-dns.com' },
    };
  }

  async payBrandingFee(scope: TenantScope) {
    await this.guardReseller(scope);

    const [config, platformCfg, wallet] = await Promise.all([
      (this.prisma as any).whiteLabelConfig.findUnique({ where: { tenantId: scope.tenantId } }),
      (this.prisma as any).platformConfig.findUnique({ where: { id: 'platform' } }).catch(() => null),
      this.prisma.wallet.findUnique({ where: { tenantId: scope.tenantId } }),
    ]);

    const feeMinor = config?.feeOverrideMinor ?? platformCfg?.whiteLabelFeeMinor ?? 0;
    if (feeMinor <= 0) return { ok: true, message: 'No fee due' };

    const balance = wallet?.balanceMinor ?? 0;
    if (balance < feeMinor) {
      throw new BadRequestException(`Insufficient wallet balance. Need ₹${(feeMinor / 100).toFixed(2)}, have ₹${(balance / 100).toFixed(2)}`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.wallet.update({ where: { tenantId: scope.tenantId }, data: { balanceMinor: { decrement: feeMinor } } });
      await (tx as any).whiteLabelConfig.update({ where: { tenantId: scope.tenantId }, data: { feeDueSince: null } });
    });

    return { ok: true, paidMinor: feeMinor };
  }

  // ── Clients ────────────────────────────────────────────────────────────────

  async listClients(scope: TenantScope, query: { page?: number; limit?: number; search?: string }) {
    await this.guardReseller(scope);
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const skip  = (page - 1) * limit;

    const where: any = { parentId: scope.tenantId };
    if (query.search?.trim()) {
      where.OR = [
        { name:  { contains: query.search.trim(), mode: 'insensitive' } },
        { users: { some: { email: { contains: query.search.trim(), mode: 'insensitive' } } } },
      ];
    }

    const [tenants, total] = await Promise.all([
      this.prisma.tenant.findMany({
        where,
        skip,
        take:    limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, name: true, isActive: true, createdAt: true,
          category:     { select: { name: true } },
          subscription: {
            select: {
              status: true, currentPeriodEnd: true,
              plan:   { select: { id: true, displayName: true } },
            },
          },
          users: {
            where:  { role: 'TENANT_OWNER' },
            take:   1,
            select: { name: true, email: true, lastLoginAt: true },
          },
          _count: { select: { users: true, contacts: true } },
          commissionsGenerated: {
            where:  { resellerId: scope.tenantId },
            select: { amountMinor: true },
          },
        },
      }),
      this.prisma.tenant.count({ where }),
    ]);

    const clients = (tenants as any[]).map((t: any) => ({
      id:       t.id,
      name:     t.name,
      isActive: t.isActive,
      createdAt: (t.createdAt as Date).toISOString(),
      managed:   true,
      commissionMinor: ((t.commissionsGenerated ?? []) as any[]).reduce((s: number, c: any) => s + (c.amountMinor ?? 0), 0),
      category:     t.category ?? null,
      subscription: t.subscription ? {
        status:           t.subscription.status,
        currentPeriodEnd: (t.subscription.currentPeriodEnd as Date).toISOString(),
        plan:             t.subscription.plan,
      } : null,
      owner: t.users?.[0] ? {
        name:        t.users[0].name,
        email:       t.users[0].email,
        lastLoginAt: t.users[0].lastLoginAt ? (t.users[0].lastLoginAt as Date).toISOString() : null,
      } : null,
      counts: { users: t._count.users, contacts: t._count.contacts },
    }));

    return { clients, total, page, limit };
  }

  async createClient(scope: TenantScope, data: {
    name: string; ownerName?: string; ownerEmail: string;
    planId: string; trialDays?: number; categoryId?: string | null;
  }) {
    await this.guardReseller(scope);

    const plan = await this.prisma.plan.findFirst({
      where: {
        id: data.planId,
        OR: [{ resellerId: scope.tenantId }, { resellerId: null, visibility: 'PUBLIC' }],
      },
      select: { id: true },
    });
    if (!plan) throw new NotFoundException('Plan not found');

    const existing = await this.prisma.user.findFirst({
      where:  { email: data.ownerEmail },
      select: { id: true },
    });
    if (existing) throw new BadRequestException('A user with this email already exists');

    const tempPassword   = this.generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 12);
    const baseSlug       = (data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) || 'client';
    const slug           = await this.uniqueSlug(baseSlug);

    const trialDays = Math.max(0, data.trialDays ?? 0);
    const periodEnd = new Date(Date.now() + Math.max(trialDays, 30) * 86_400_000);

    const { user } = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name:         data.name,
          slug,
          parentId:     scope.tenantId,
          referredById: scope.tenantId,
          accountType:  'CLIENT',
          ...(data.categoryId ? { categoryId: data.categoryId } : {}),
          settings: { create: {} },
        },
      });

      const user = await tx.user.create({
        data: {
          tenantId:      tenant.id,
          name:          data.ownerName ?? data.name,
          email:         data.ownerEmail,
          password:      hashedPassword,
          role:          'TENANT_OWNER',
          emailVerified: true,
        },
      });

      await tx.subscription.create({
        data: {
          tenantId:           tenant.id,
          planId:             data.planId,
          status:             trialDays > 0 ? 'TRIALING' : 'ACTIVE',
          billingCycle:       'MONTHLY',
          currentPeriodStart: new Date(),
          currentPeriodEnd:   periodEnd,
          ...(trialDays > 0 ? { trialEndsAt: periodEnd } : {}),
        },
      });

      await tx.wallet.upsert({
        where:  { tenantId: tenant.id },
        create: { tenantId: tenant.id, balanceMinor: 0 },
        update: {},
      });

      return { tenant, user };
    });

    return { owner: { email: user.email }, tempPassword, emailSent: false };
  }

  async getClient(scope: TenantScope, clientId: string) {
    await this.guardReseller(scope);

    const client = await this.prisma.tenant.findFirst({
      where:  { id: clientId, parentId: scope.tenantId },
      select: {
        id: true, name: true, isActive: true, createdAt: true,
        category: { select: { id: true, name: true } },
        subscription: {
          select: {
            status: true, currentPeriodEnd: true, trialEndsAt: true,
            plan: {
              select: { id: true, displayName: true, priceMonthly: true, maxContacts: true, maxMsgPerMonth: true, maxAgents: true, maxCampaigns: true },
            },
          },
        },
        users: {
          select:  { name: true, email: true, role: true, isActive: true, lastLoginAt: true },
          orderBy: { createdAt: 'asc' },
        },
        wallet: { select: { balanceMinor: true } },
        _count: { select: { users: true, contacts: true, campaigns: true } },
        commissionsGenerated: {
          where:   { resellerId: scope.tenantId },
          select:  { id: true, amountMinor: true, baseMinor: true, rate: true, currency: true, status: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take:    20,
        },
      },
    });
    if (!client) throw new NotFoundException('Client not found');

    const sub  = client.subscription as any;
    const plan = sub?.plan ?? {};
    const usage: Record<string, { used: number; limit: number }> = {
      contacts:  { used: (client._count as any).contacts,  limit: plan.maxContacts    ?? 0 },
      messages:  { used: 0,                                limit: plan.maxMsgPerMonth ?? 0 },
      users:     { used: (client._count as any).users,     limit: plan.maxAgents      ?? 0 },
      campaigns: { used: (client._count as any).campaigns, limit: plan.maxCampaigns   ?? 0 },
    };

    return {
      id:       client.id,
      name:     client.name,
      isActive: client.isActive,
      createdAt: (client.createdAt as Date).toISOString(),
      managed:   true,
      category:  client.category ?? null,
      subscription: sub ? {
        status:           sub.status,
        currentPeriodEnd: (sub.currentPeriodEnd as Date).toISOString(),
        trialEndsAt:      sub.trialEndsAt ? (sub.trialEndsAt as Date).toISOString() : null,
        plan: { id: plan.id, displayName: plan.displayName, priceMonthly: plan.priceMonthly },
      } : null,
      users: (client.users as any[]).map((u: any) => ({
        name:        u.name,
        email:       u.email,
        role:        u.role,
        isActive:    u.isActive,
        lastLoginAt: u.lastLoginAt ? (u.lastLoginAt as Date).toISOString() : null,
      })),
      usage,
      commissions: (client.commissionsGenerated as any[]).map((c: any) => ({
        id:          c.id,
        amountMinor: c.amountMinor,
        baseMinor:   c.baseMinor,
        rate:        c.rate,
        currency:    c.currency,
        status:      c.status,
        createdAt:   (c.createdAt as Date).toISOString(),
      })),
      walletBalanceMinor: (client.wallet as any)?.balanceMinor ?? 0,
    };
  }

  async updateClient(scope: TenantScope, clientId: string, data: {
    isActive?: boolean;
    planId?:   string;
  }) {
    await this.guardReseller(scope);
    const client = await this.prisma.tenant.findFirst({
      where:  { id: clientId, parentId: scope.tenantId },
      select: { id: true },
    });
    if (!client) throw new NotFoundException('Client not found');

    if (data.planId !== undefined) {
      const plan = await this.prisma.plan.findFirst({
        where: {
          id: data.planId,
          OR: [{ resellerId: scope.tenantId }, { resellerId: null, visibility: 'PUBLIC' }],
        },
        select: { id: true },
      });
      if (!plan) throw new NotFoundException('Plan not found');

      const existing = await this.prisma.subscription.findUnique({ where: { tenantId: clientId }, select: { id: true } });
      if (existing) {
        await this.prisma.subscription.update({ where: { tenantId: clientId }, data: { planId: data.planId } });
      } else {
        await this.prisma.subscription.create({
          data: {
            tenantId:           clientId,
            planId:             data.planId,
            status:             'ACTIVE',
            billingCycle:       'MONTHLY',
            currentPeriodStart: new Date(),
            currentPeriodEnd:   new Date(Date.now() + 30 * 86_400_000),
          },
        });
      }
    }

    if (data.isActive !== undefined) {
      await this.prisma.tenant.update({ where: { id: clientId }, data: { isActive: data.isActive } });
    }

    return { ok: true };
  }

  // ── Plans ──────────────────────────────────────────────────────────────────

  async listPlans(scope: TenantScope) {
    await this.guardReseller(scope);

    const [resellerPlans, basePlans] = await Promise.all([
      this.prisma.plan.findMany({
        where:   { resellerId: scope.tenantId },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true, displayName: true, description: true, priceMonthly: true, priceAnnual: true,
          isActive: true, basePlanId: true, maxContacts: true, maxMsgPerMonth: true, maxAgents: true,
          _count: { select: { subscriptions: true } },
        },
      }),
      this.prisma.plan.findMany({
        where:   { resellerId: null, visibility: 'PUBLIC', isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true, displayName: true, priceMonthly: true, priceAnnual: true,
          maxContacts: true, maxMsgPerMonth: true, maxAgents: true,
        },
      }),
    ]);

    const plans = (resellerPlans as any[]).map((p: any) => ({
      id:             p.id,
      displayName:    p.displayName,
      description:    p.description  ?? null,
      priceMonthly:   p.priceMonthly,
      priceAnnual:    p.priceAnnual,
      isActive:       p.isActive,
      basePlanId:     p.basePlanId   ?? null,
      maxContacts:    p.maxContacts,
      maxMsgPerMonth: p.maxMsgPerMonth,
      maxAgents:      p.maxAgents,
      clients:        p._count.subscriptions,
    }));

    return { plans, basePlans };
  }

  async createPlan(scope: TenantScope, data: {
    displayName: string; description?: string; basePlanId: string;
    priceMonthly: number; priceAnnual?: number;
  }) {
    await this.guardReseller(scope);

    const base = await this.prisma.plan.findFirst({
      where:  { id: data.basePlanId, resellerId: null },
    });
    if (!base) throw new NotFoundException('Base plan not found');
    if (data.priceMonthly < base.priceMonthly) {
      throw new BadRequestException(`Monthly price must be at least ₹${base.priceMonthly} (base plan minimum)`);
    }

    const suffix = data.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
    const name   = `${scope.tenantId.slice(-6)}-${suffix}`;

    return this.prisma.plan.create({
      data: {
        name,
        displayName:    data.displayName,
        description:    data.description,
        priceMonthly:   data.priceMonthly,
        priceAnnual:    data.priceAnnual ?? data.priceMonthly * 12,
        maxContacts:    base.maxContacts,
        maxMsgPerMonth: base.maxMsgPerMonth,
        maxAgents:      base.maxAgents,
        maxCampaigns:   base.maxCampaigns,
        maxFlows:       base.maxFlows,
        resellerId:     scope.tenantId,
        basePlanId:     data.basePlanId,
      } as any,
    });
  }

  async updatePlan(scope: TenantScope, planId: string, data: {
    displayName?: string; description?: string; priceMonthly?: number;
    priceAnnual?: number; isActive?: boolean;
  }) {
    await this.guardReseller(scope);
    const plan = await this.prisma.plan.findFirst({
      where:  { id: planId, resellerId: scope.tenantId },
      select: { id: true, basePlanId: true },
    });
    if (!plan) throw new NotFoundException('Plan not found');

    if (data.priceMonthly !== undefined && plan.basePlanId) {
      const base = await this.prisma.plan.findUnique({
        where:  { id: plan.basePlanId },
        select: { priceMonthly: true },
      });
      if (base && data.priceMonthly < base.priceMonthly) {
        throw new BadRequestException(`Monthly price must be at least ₹${base.priceMonthly} (base plan minimum)`);
      }
    }

    return this.prisma.plan.update({
      where: { id: planId },
      data: {
        ...(data.displayName  !== undefined && { displayName:  data.displayName }),
        ...(data.description  !== undefined && { description:  data.description }),
        ...(data.priceMonthly !== undefined && { priceMonthly: data.priceMonthly }),
        ...(data.priceAnnual  !== undefined && { priceAnnual:  data.priceAnnual }),
        ...(data.isActive     !== undefined && { isActive:     data.isActive }),
      } as any,
    });
  }

  async deletePlan(scope: TenantScope, planId: string) {
    await this.guardReseller(scope);
    const plan = await this.prisma.plan.findFirst({
      where:  { id: planId, resellerId: scope.tenantId },
      select: { id: true },
    });
    if (!plan) throw new NotFoundException('Plan not found');

    const activeClients = await this.prisma.subscription.count({
      where: { planId, status: { in: ['ACTIVE', 'TRIALING'] } },
    });
    if (activeClients > 0) {
      throw new BadRequestException('Clients are on this plan. Deactivate it instead of deleting.');
    }

    await this.prisma.plan.update({ where: { id: planId }, data: { isActive: false } as any });
    return { ok: true };
  }

  // ── Rates ──────────────────────────────────────────────────────────────────

  async listRates(scope: TenantScope) {
    await this.guardReseller(scope);

    const CATEGORIES = ['WA_MARKETING', 'WA_UTILITY', 'WA_AUTHENTICATION'];
    const [platformRates, resellerRates] = await Promise.all([
      this.prisma.messageRate.findMany({ where: { resellerId: null } }),
      this.prisma.messageRate.findMany({ where: { resellerId: scope.tenantId } }),
    ]);

    const platformMap = new Map((platformRates as any[]).map((r: any) => [r.category as string, r.priceMinor as number]));
    const resellerMap = new Map((resellerRates as any[]).map((r: any) => [r.category as string, r.priceMinor as number]));

    return CATEGORIES.map((cat) => ({
      category:      cat,
      platformMinor: platformMap.has(cat) ? platformMap.get(cat) : null,
      yoursMinor:    resellerMap.has(cat) ? resellerMap.get(cat) : null,
    }));
  }

  async upsertRate(scope: TenantScope, data: { category: string; priceMinor: number | null }) {
    await this.guardReseller(scope);

    if (data.priceMinor === null) {
      await this.prisma.messageRate.deleteMany({
        where: { category: data.category as any, resellerId: scope.tenantId },
      });
      return { ok: true };
    }

    const platformRate = await this.prisma.messageRate.findFirst({
      where:  { category: data.category as any, resellerId: null },
      select: { priceMinor: true },
    });
    if (platformRate && data.priceMinor < platformRate.priceMinor) {
      throw new BadRequestException(`Price must be at least ${platformRate.priceMinor} paise (platform rate)`);
    }

    return this.prisma.messageRate.upsert({
      where:  { category_resellerId: { category: data.category as any, resellerId: scope.tenantId } },
      create: { category: data.category as any, resellerId: scope.tenantId, priceMinor: data.priceMinor },
      update: { priceMinor: data.priceMinor },
    });
  }

  // ── Commissions ────────────────────────────────────────────────────────────

  async listCommissions(scope: TenantScope, query: { page?: number; limit?: number; status?: string }) {
    await this.guardReseller(scope);
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const skip  = (page - 1) * limit;

    const where: any = { resellerId: scope.tenantId };
    if (query.status && query.status !== 'ALL') where.status = query.status;

    const [commissions, total, totalsAgg] = await Promise.all([
      this.prisma.resellerCommission.findMany({
        where,
        skip,
        take:    limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, baseMinor: true, amountMinor: true, rate: true, currency: true,
          status: true, createdAt: true, paidAt: true, note: true,
          client:  { select: { id: true, name: true } },
          payment: { select: { purpose: true, provider: true } },
        },
      }),
      this.prisma.resellerCommission.count({ where }),
      this.prisma.resellerCommission.groupBy({
        by:    ['status'],
        where: { resellerId: scope.tenantId },
        _sum:  { amountMinor: true },
      }),
    ]);

    const totals: Record<string, number> = { PENDING: 0, PAID: 0, CANCELLED: 0 };
    for (const agg of totalsAgg as any[]) {
      totals[agg.status as string] = (agg._sum as any).amountMinor ?? 0;
    }

    const rows = (commissions as any[]).map((c: any) => ({
      id:          c.id,
      baseMinor:   c.baseMinor,
      amountMinor: c.amountMinor,
      rate:        c.rate,
      currency:    c.currency,
      status:      c.status,
      createdAt:   (c.createdAt as Date).toISOString(),
      paidAt:      c.paidAt ? (c.paidAt as Date).toISOString() : null,
      note:        c.note ?? null,
      client:      c.client,
      payment:     c.payment,
    }));

    return { commissions: rows, total, page, limit, totals };
  }

  // ── SMTP ───────────────────────────────────────────────────────────────────

  async getSmtp(scope: TenantScope) {
    await this.guardReseller(scope);
    const s = await this.prisma.tenantSettings.findUnique({
      where:  { tenantId: scope.tenantId },
      select: { smtpHost: true, smtpPort: true, smtpUser: true, smtpFrom: true },
    });
    return s ?? { smtpHost: null, smtpPort: null, smtpUser: null, smtpFrom: null };
  }

  async updateSmtp(scope: TenantScope, data: {
    smtpHost?: string | null; smtpPort?: number | null; smtpUser?: string | null;
    smtpPass?: string | null; smtpFrom?: string | null;
  }) {
    await this.guardReseller(scope);
    await this.prisma.tenantSettings.upsert({
      where:  { tenantId: scope.tenantId },
      create: { tenantId: scope.tenantId, ...data } as any,
      update: data as any,
    });
    return { ok: true };
  }

  async clearSmtp(scope: TenantScope) {
    await this.guardReseller(scope);
    await this.prisma.tenantSettings.updateMany({
      where: { tenantId: scope.tenantId },
      data:  { smtpHost: null, smtpPort: null, smtpUser: null, smtpPass: null, smtpFrom: null } as any,
    });
    return { ok: true };
  }

  // ── Client Report ──────────────────────────────────────────────────────────

  async getClientReport(scope: TenantScope, clientTenantId: string, query: { days?: number }) {
    await this.guardReseller(scope);
    const client = await this.prisma.tenant.findFirst({
      where:  { id: clientTenantId, parentId: scope.tenantId },
      select: { id: true },
    });
    if (!client) throw new NotFoundException('Client not found');

    const days  = Math.max(1, Math.min(365, query.days ?? 30));
    const since = new Date(Date.now() - days * 86_400_000);

    const [msgGroups, contactsAdded, campaigns, recentCampaigns, spentAgg, openConv] = await Promise.all([
      this.prisma.message.groupBy({
        by:    ['status', 'direction'],
        where: { tenantId: clientTenantId, createdAt: { gte: since } },
        _count: { id: true },
      }),
      this.prisma.contact.count({ where: { tenantId: clientTenantId, createdAt: { gte: since } } }),
      this.prisma.campaign.count({ where: { tenantId: clientTenantId, createdAt: { gte: since } } }),
      this.prisma.campaign.findMany({
        where:   { tenantId: clientTenantId, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take:    5,
        select: {
          id: true, name: true, status: true, createdAt: true,
          totalCount: true, sentCount: true, deliveredCount: true, readCount: true, failedCount: true,
        },
      }),
      this.prisma.walletTransaction.aggregate({
        where: { tenantId: clientTenantId, type: 'DEBIT', createdAt: { gte: since } },
        _sum:  { amountMinor: true },
      }),
      this.prisma.conversation.count({
        where: { tenantId: clientTenantId, status: { in: ['OPEN', 'ASSIGNED'] } },
      }),
    ]);

    const totalConv = await this.prisma.conversation.count({ where: { tenantId: clientTenantId, createdAt: { gte: since } } });

    const msgStats = { sent: 0, delivered: 0, read: 0, failed: 0, received: 0 };
    for (const row of msgGroups as any[]) {
      const count = (row._count as any).id ?? 0;
      if      (row.direction === 'INBOUND')    msgStats.received  += count;
      else if (row.status    === 'SENT')       msgStats.sent      += count;
      else if (row.status    === 'DELIVERED')  msgStats.delivered += count;
      else if (row.status    === 'READ')       msgStats.read      += count;
      else if (row.status    === 'FAILED')     msgStats.failed    += count;
    }

    return {
      days,
      messages:      msgStats,
      daily:         [] as any[],
      conversations: { started: totalConv, open: openConv },
      contactsAdded,
      campaigns: {
        count:  campaigns,
        recent: (recentCampaigns as any[]).map((c: any) => ({
          id:        c.id,
          name:      c.name,
          status:    c.status,
          createdAt: (c.createdAt as Date).toISOString(),
          total:     c.totalCount,
          sent:      c.sentCount,
          delivered: c.deliveredCount,
          read:      c.readCount,
          failed:    c.failedCount,
        })),
      },
      spentMinor: (spentAgg._sum as any).amountMinor ?? 0,
    };
  }

  // ── Wallet Transfer ────────────────────────────────────────────────────────

  async transferToClient(scope: TenantScope, clientTenantId: string, body: { amountMinor: number; note?: string }) {
    await this.guardReseller(scope);
    const client = await this.prisma.tenant.findFirst({
      where:  { id: clientTenantId, parentId: scope.tenantId },
      select: { id: true },
    });
    if (!client) throw new NotFoundException('Client not found');
    if (body.amountMinor <= 0) throw new BadRequestException('Amount must be positive');

    const wallet = await this.prisma.wallet.findUnique({ where: { tenantId: scope.tenantId } });
    if (!wallet || wallet.balanceMinor < body.amountMinor) {
      throw new BadRequestException('Insufficient wallet balance');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.wallet.update({ where: { tenantId: scope.tenantId }, data: { balanceMinor: { decrement: body.amountMinor } } });
      await tx.wallet.upsert({
        where:  { tenantId: clientTenantId },
        create: { tenantId: clientTenantId, balanceMinor: body.amountMinor },
        update: { balanceMinor: { increment: body.amountMinor } },
      });
    });
    return { ok: true, amountMinor: body.amountMinor };
  }
}
