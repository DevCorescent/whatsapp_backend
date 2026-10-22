import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

@Injectable()
export class ResellerService {
  constructor(private readonly prisma: PrismaService) {}

  private async guardReseller(scope: TenantScope) {
    const tenant = await this.prisma.tenant.findUnique({
      where:  { id: scope.tenantId },
      select: { accountType: true, resellerType: true },
    });
    if (!tenant || tenant.accountType !== 'RESELLER') {
      throw new ForbiddenException('Reseller account only');
    }
    return tenant;
  }

  // ── Overview ───────────────────────────────────────────────────────────────

  async getOverview(scope: TenantScope) {
    await this.guardReseller(scope);

    const [clients, activePlans, commissionAgg, pendingAgg, wlConfig] = await Promise.all([
      this.prisma.tenant.count({ where: { parentId: scope.tenantId } }),
      this.prisma.plan.count({ where: { resellerId: scope.tenantId, isActive: true } }),
      this.prisma.resellerCommission.aggregate({
        where:   { resellerId: scope.tenantId, status: 'PAID' },
        _sum:    { amountMinor: true },
      }),
      this.prisma.resellerCommission.aggregate({
        where:   { resellerId: scope.tenantId, status: 'PENDING' },
        _sum:    { amountMinor: true },
      }),
      this.prisma.whiteLabelConfig.findUnique({
        where:  { tenantId: scope.tenantId },
        select: { isActive: true },
      }),
    ]);

    return {
      clients,
      activePlans,
      totalEarned:        commissionAgg._sum.amountMinor ?? 0,
      pendingCommissions: pendingAgg._sum.amountMinor ?? 0,
      whiteLabel:         wlConfig?.isActive ?? false,
    };
  }

  // ── Branding ───────────────────────────────────────────────────────────────

  async getBranding(scope: TenantScope) {
    await this.guardReseller(scope);
    const config = await this.prisma.whiteLabelConfig.findUnique({
      where: { tenantId: scope.tenantId },
    });
    return config ?? null;
  }

  async upsertBranding(scope: TenantScope, data: {
    brandName: string;
    logoUrl?: string;
    faviconUrl?: string;
    primaryColor?: string;
    accentColor?: string;
    domain?: string;
    supportEmail?: string;
    supportPhone?: string;
    website?: string;
    address?: string;
    loginHeadline?: string;
    loginSubtext?: string;
    subdomain?: string;
    landingEnabled?: boolean;
    landingTitle?: string;
    landingSubtitle?: string;
    termsContent?: string;
    privacyContent?: string;
  }) {
    await this.guardReseller(scope);

    const payload = {
      brandName:      data.brandName,
      logoUrl:        data.logoUrl,
      faviconUrl:     data.faviconUrl,
      primaryColor:   data.primaryColor,
      accentColor:    data.accentColor,
      domain:         data.domain,
      supportEmail:   data.supportEmail,
      supportPhone:   data.supportPhone,
      website:        data.website,
      address:        data.address,
      loginHeadline:  data.loginHeadline,
      loginSubtext:   data.loginSubtext,
      subdomain:      data.subdomain,
      landingEnabled: data.landingEnabled,
      landingTitle:   data.landingTitle,
      landingSubtitle: data.landingSubtitle,
      termsContent:   data.termsContent,
      privacyContent: data.privacyContent,
    };

    return this.prisma.whiteLabelConfig.upsert({
      where:  { tenantId: scope.tenantId },
      create: { tenantId: scope.tenantId, ...payload } as any,
      update: payload as any,
    });
  }

  async checkDomainAvailable(scope: TenantScope, domain: string) {
    await this.guardReseller(scope);
    const existing = await this.prisma.whiteLabelConfig.findFirst({
      where: {
        domain,
        tenantId: { not: scope.tenantId },
      },
      select: { id: true },
    });
    return { available: !existing };
  }

  // ── Clients ────────────────────────────────────────────────────────────────

  async listClients(scope: TenantScope, query: { page?: number; limit?: number }) {
    await this.guardReseller(scope);
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const skip  = (page - 1) * limit;

    const [clients, total] = await Promise.all([
      this.prisma.tenant.findMany({
        where:   { parentId: scope.tenantId },
        skip,
        take:    limit,
        orderBy: { createdAt: 'desc' },
        include: {
          subscription: { include: { plan: { select: { name: true, displayName: true } } } },
        },
      }),
      this.prisma.tenant.count({ where: { parentId: scope.tenantId } }),
    ]);

    return { clients, total, page, limit };
  }

  async getClient(scope: TenantScope, clientId: string) {
    await this.guardReseller(scope);
    const client = await this.prisma.tenant.findFirst({
      where:   { id: clientId, parentId: scope.tenantId },
      include: {
        subscription: { include: { plan: true } },
        wallet:       true,
      },
    });
    if (!client) throw new NotFoundException('Client not found');
    return client;
  }

  async updateClient(scope: TenantScope, clientId: string, data: {
    isActive?: boolean;
    commissionRate?: number;
  }) {
    await this.guardReseller(scope);
    const client = await this.prisma.tenant.findFirst({
      where:  { id: clientId, parentId: scope.tenantId },
      select: { id: true },
    });
    if (!client) throw new NotFoundException('Client not found');

    return this.prisma.tenant.update({
      where: { id: clientId },
      data:  {
        isActive:       data.isActive,
        commissionRate: data.commissionRate,
      } as any,
    });
  }

  // ── Plans ──────────────────────────────────────────────────────────────────

  async listPlans(scope: TenantScope) {
    await this.guardReseller(scope);
    return this.prisma.plan.findMany({
      where:   { resellerId: scope.tenantId },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async createPlan(scope: TenantScope, data: {
    name: string;
    displayName: string;
    description?: string;
    priceMonthly: number;
    priceAnnual: number;
    maxContacts: number;
    maxMsgPerMonth: number;
    maxAgents: number;
    maxCampaigns: number;
    maxFlows: number;
    basePlanId?: string;
  }) {
    await this.guardReseller(scope);

    let baseLimits: Partial<typeof data> = {};
    if (data.basePlanId) {
      const base = await this.prisma.plan.findUnique({ where: { id: data.basePlanId } });
      if (!base) throw new NotFoundException('Base plan not found');
      baseLimits = {
        maxContacts:    base.maxContacts,
        maxMsgPerMonth: base.maxMsgPerMonth,
        maxAgents:      base.maxAgents,
        maxCampaigns:   base.maxCampaigns,
        maxFlows:       base.maxFlows,
      };
    }

    return this.prisma.plan.create({
      data: {
        name:           data.name,
        displayName:    data.displayName,
        description:    data.description,
        priceMonthly:   data.priceMonthly,
        priceAnnual:    data.priceAnnual,
        maxContacts:    baseLimits.maxContacts    ?? data.maxContacts,
        maxMsgPerMonth: baseLimits.maxMsgPerMonth ?? data.maxMsgPerMonth,
        maxAgents:      baseLimits.maxAgents      ?? data.maxAgents,
        maxCampaigns:   baseLimits.maxCampaigns   ?? data.maxCampaigns,
        maxFlows:       baseLimits.maxFlows       ?? data.maxFlows,
        resellerId:     scope.tenantId,
        basePlanId:     data.basePlanId,
      } as any,
    });
  }

  async updatePlan(scope: TenantScope, planId: string, data: {
    name?: string;
    displayName?: string;
    description?: string;
    priceMonthly?: number;
    priceAnnual?: number;
  }) {
    await this.guardReseller(scope);
    const plan = await this.prisma.plan.findFirst({
      where:  { id: planId, resellerId: scope.tenantId },
      select: { id: true },
    });
    if (!plan) throw new NotFoundException('Plan not found');

    return this.prisma.plan.update({
      where: { id: planId },
      data:  {
        name:         data.name,
        displayName:  data.displayName,
        description:  data.description,
        priceMonthly: data.priceMonthly,
        priceAnnual:  data.priceAnnual,
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

    await this.prisma.plan.update({
      where: { id: planId },
      data:  { isActive: false },
    });
    return { success: true };
  }

  // ── Rates ──────────────────────────────────────────────────────────────────

  async listRates(scope: TenantScope) {
    await this.guardReseller(scope);
    return this.prisma.messageRate.findMany({
      where:   { resellerId: scope.tenantId },
      orderBy: { category: 'asc' },
    });
  }

  async upsertRate(scope: TenantScope, data: { category: string; priceMinor: number }) {
    await this.guardReseller(scope);
    return this.prisma.messageRate.upsert({
      where:  { category_resellerId: { category: data.category as any, resellerId: scope.tenantId } },
      create: { category: data.category as any, resellerId: scope.tenantId, priceMinor: data.priceMinor },
      update: { priceMinor: data.priceMinor },
    });
  }

  // ── Commissions ────────────────────────────────────────────────────────────

  async listCommissions(scope: TenantScope, query: {
    page?: number;
    limit?: number;
    status?: string;
  }) {
    await this.guardReseller(scope);
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const skip  = (page - 1) * limit;

    const where: any = { resellerId: scope.tenantId };
    if (query.status) where.status = query.status;

    const [commissions, total] = await Promise.all([
      this.prisma.resellerCommission.findMany({
        where,
        skip,
        take:    limit,
        orderBy: { createdAt: 'desc' },
        include: { client: { select: { id: true, name: true, slug: true } } },
      }),
      this.prisma.resellerCommission.count({ where }),
    ]);

    return { commissions, total, page, limit };
  }

  // ── SMTP ───────────────────────────────────────────────────────────────────

  async getSmtp(scope: TenantScope) {
    await this.guardReseller(scope);
    const settings = await this.prisma.tenantSettings.findUnique({
      where:  { tenantId: scope.tenantId },
      select: { smtpHost: true, smtpPort: true, smtpUser: true, smtpFrom: true },
    });
    return settings ?? { smtpHost: null, smtpPort: null, smtpUser: null, smtpFrom: null };
  }

  async updateSmtp(scope: TenantScope, data: {
    smtpHost?: string;
    smtpPort?: number;
    smtpUser?: string;
    smtpPass?: string;
    smtpFrom?: string;
  }) {
    await this.guardReseller(scope);
    return this.prisma.tenantSettings.upsert({
      where:  { tenantId: scope.tenantId },
      create: {
        tenantId: scope.tenantId,
        smtpHost: data.smtpHost,
        smtpPort: data.smtpPort,
        smtpUser: data.smtpUser,
        smtpPass: data.smtpPass,
        smtpFrom: data.smtpFrom,
      },
      update: {
        smtpHost: data.smtpHost,
        smtpPort: data.smtpPort,
        smtpUser: data.smtpUser,
        smtpPass: data.smtpPass,
        smtpFrom: data.smtpFrom,
      },
    });
  }

  async clearSmtp(scope: TenantScope) {
    await this.guardReseller(scope);
    const settings = await this.prisma.tenantSettings.findUnique({
      where:  { tenantId: scope.tenantId },
      select: { id: true },
    });
    if (!settings) return { success: true };

    await this.prisma.tenantSettings.update({
      where: { tenantId: scope.tenantId },
      data:  { smtpHost: null, smtpPort: null, smtpUser: null, smtpPass: null, smtpFrom: null },
    });
    return { success: true };
  }

  // ── Client Report ──────────────────────────────────────────────────────────

  async getClientReport(scope: TenantScope, clientTenantId: string) {
    await this.guardReseller(scope);
    const client = await this.prisma.tenant.findFirst({
      where:  { id: clientTenantId, parentId: scope.tenantId },
      select: { id: true },
    });
    if (!client) throw new NotFoundException('Client not found');

    const [messages, campaigns, wallet] = await Promise.all([
      this.prisma.message.groupBy({
        by:    ['status'],
        where: { tenantId: clientTenantId },
        _count: { id: true },
      }),
      this.prisma.campaign.count({ where: { tenantId: clientTenantId } }),
      this.prisma.wallet.findUnique({ where: { tenantId: clientTenantId }, select: { balanceMinor: true } }),
    ]);
    const stats: Record<string, number> = {};
    for (const row of messages) stats[(row.status as string).toLowerCase()] = (row._count as any).id;
    return { messages: stats, campaigns, walletBalance: wallet?.balanceMinor ?? 0 };
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
    const resellerWallet = await this.prisma.wallet.findUnique({ where: { tenantId: scope.tenantId } });
    if (!resellerWallet || resellerWallet.balanceMinor < body.amountMinor) {
      throw new BadRequestException('Insufficient wallet balance');
    }
    await this.prisma.$transaction(async tx => {
      await tx.wallet.update({ where: { tenantId: scope.tenantId }, data: { balanceMinor: { decrement: body.amountMinor } } });
      await tx.wallet.upsert({
        where:  { tenantId: clientTenantId },
        create: { tenantId: clientTenantId, balanceMinor: body.amountMinor },
        update: { balanceMinor: { increment: body.amountMinor } },
      });
    });
    return { ok: true, amountMinor: body.amountMinor };
  }

  // ── Branding Fee ───────────────────────────────────────────────────────────

  async payBrandingFee(scope: TenantScope) {
    await this.guardReseller(scope);
    const wallet = await this.prisma.wallet.findUnique({ where: { tenantId: scope.tenantId } });
    return { ok: true, walletBalance: wallet?.balanceMinor ?? 0 };
  }
}
