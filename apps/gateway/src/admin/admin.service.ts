import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope, PERMISSIONS, accountCeiling, roleDefaults, resolvePermission } from '@lib/common';
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
  constructor(private readonly prisma: PrismaService) {}

  private guard(scope: TenantScope) {
    if (scope.role !== 'SUPER_ADMIN') throw new ForbiddenException('Super admin only');
  }

  // ── Tenants ────────────────────────────────────────────────────────────────

  async listTenants(
    scope: TenantScope,
    query: { page?: number; limit?: number; search?: string; accountType?: string; planId?: string; isActive?: string },
  ) {
    this.guard(scope);
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
    const msgCounts = tenantIds.length
      ? await this.prisma.message.groupBy({
          by:    ['tenantId'],
          where: { tenantId: { in: tenantIds }, createdAt: { gte: startOfMonth } },
          _count: { _all: true },
        })
      : [];
    const msgByTenant = new Map(msgCounts.map(r => [r.tenantId, r._count._all]));

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
    this.guard(scope);
    const tenant = await this.prisma.tenant.findUnique({
      where:   { id: tenantId },
      include: {
        subscription: { include: { plan: true } },
        users:        { select: { id: true, name: true, email: true, role: true } },
        businesses:   { select: { id: true, name: true, slug: true } },
      },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');
    return tenant;
  }

  async updateTenant(scope: TenantScope, id: string, data: { isActive?: boolean; name?: string; categoryId?: string }) {
    this.guard(scope);
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw new NotFoundException('Tenant not found');
    return this.prisma.tenant.update({ where: { id }, data: data as any });
  }

  // ── Audit Logs ─────────────────────────────────────────────────────────────

  async listAuditLogs(scope: TenantScope, query: { tenantId?: string; page?: number; limit?: number; q?: string }) {
    this.guard(scope);
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
    this.guard(scope);
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
    this.guard(scope);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const hashed = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({ where: { id: userId }, data: { password: hashed } });
    return { success: true };
  }

  // ── Wallet ─────────────────────────────────────────────────────────────────

  async adminGetTenantWallet(scope: TenantScope, tenantId: string) {
    this.guard(scope);
    const wallet = await this.prisma.wallet.findUnique({ where: { tenantId } });
    if (!wallet) throw new NotFoundException('Wallet not found for tenant');
    const transactions = await this.prisma.walletTransaction.findMany({
      where:   { tenantId },
      orderBy: { createdAt: 'desc' },
      take:    20,
    });
    return { wallet, transactions };
  }

  async adminAdjustWallet(scope: TenantScope, tenantId: string, amount: number, note: string) {
    this.guard(scope);
    const existing = await this.prisma.wallet.findUnique({ where: { tenantId } });
    const currentBalance = existing?.balanceMinor ?? 0;
    const newBalance = currentBalance + amount;

    const wallet = await this.prisma.wallet.upsert({
      where:  { tenantId },
      create: { tenantId, balanceMinor: newBalance },
      update: { balanceMinor: newBalance },
    });

    const tx = await this.prisma.walletTransaction.create({
      data: {
        tenantId,
        type:             'ADJUSTMENT',
        amountMinor:      amount,
        balanceAfterMinor: newBalance,
        description:      note,
      } as any,
    });

    return { wallet, transaction: tx };
  }

  // ── Business Categories ────────────────────────────────────────────────────

  async listCategories(scope: TenantScope) {
    this.guard(scope);
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
    this.guard(scope);
    const created = await this.prisma.businessCategory.create({ data: data as any });
    return { success: true, data: { ...created, accounts: 0 } };
  }

  async updateCategory(scope: TenantScope, id: string, data: { name?: string; isActive?: boolean; sortOrder?: number }) {
    this.guard(scope);
    const cat = await this.prisma.businessCategory.findUnique({ where: { id } });
    if (!cat) throw new NotFoundException('Category not found');
    const updated = await this.prisma.businessCategory.update({ where: { id }, data: data as any });
    return { success: true, data: updated };
  }

  async deleteCategory(scope: TenantScope, id: string) {
    this.guard(scope);
    const cat = await this.prisma.businessCategory.findUnique({ where: { id } });
    if (!cat) throw new NotFoundException('Category not found');
    const usageCount = await this.prisma.tenant.count({ where: { categoryId: id } });
    if (usageCount > 0) throw new BadRequestException('Category is used by active workspaces');
    await this.prisma.businessCategory.delete({ where: { id } });
    return { success: true };
  }

  // ── Message Rates ──────────────────────────────────────────────────────────

  async listRates(scope: TenantScope) {
    this.guard(scope);
    const RATE_CATEGORIES = ['WA_MARKETING', 'WA_UTILITY', 'WA_AUTHENTICATION'];
    const dbRates = await this.prisma.messageRate.findMany({ where: { resellerId: null } });
    const byCategory = new Map(dbRates.map(r => [r.category as string, r.priceMinor]));
    return {
      success: true,
      data: RATE_CATEGORIES.map(category => ({ category, priceMinor: byCategory.get(category) ?? null })),
    };
  }

  async updateRate(scope: TenantScope, category: string, resellerId: string | null | undefined, priceMinor: number | null | undefined) {
    this.guard(scope);
    if (priceMinor == null) {
      await this.prisma.messageRate.deleteMany({
        where: { category: category as any, resellerId: resellerId ?? null },
      });
    } else {
      await this.prisma.messageRate.upsert({
        where:  { category_resellerId: { category: category as any, resellerId: (resellerId ?? null) as any } },
        create: { category: category as any, resellerId: resellerId ?? null, priceMinor },
        update: { priceMinor },
      });
    }
    await this.prisma.auditLog.create({
      data: {
        tenantId:   scope.tenantId,
        userId:     scope.userId,
        action:     'RATE_UPDATED',
        resource:   'messageRate',
        resourceId: category,
        metadata:   { priceMinor: priceMinor ?? null, resellerId: resellerId ?? null },
      },
    });
    return { success: true };
  }

  // ── Plans ──────────────────────────────────────────────────────────────────

  async listPlans(scope: TenantScope) {
    this.guard(scope);
    return this.prisma.plan.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  async createPlan(scope: TenantScope, data: {
    name: string; displayName: string; description?: string;
    priceMonthly: number; priceAnnual: number;
    maxContacts: number; maxMsgPerMonth: number; maxAgents: number;
    maxCampaigns: number; aiEnabled?: boolean; features?: string[];
  }) {
    this.guard(scope);
    return this.prisma.plan.create({ data: data as any });
  }

  async updatePlan(scope: TenantScope, planId: string, data: Record<string, unknown>) {
    this.guard(scope);
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
    return this.prisma.plan.update({ where: { id: planId }, data: data as any });
  }

  // ── Assign plan to tenant ──────────────────────────────────────────────────

  async assignPlan(scope: TenantScope, tenantId: string, planId: string, billingCycle: string) {
    this.guard(scope);
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
    this.guard(scope);

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
    this.guard(scope);

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
    this.guard(scope);
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
    this.guard(scope);

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
    this.guard(scope);
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

  async startViewAs(scope: TenantScope, tenantId: string) {
    this.guard(scope);
    if (!tenantId) throw new BadRequestException('Choose an account');
    const tenant = await this.prisma.tenant.findUnique({
      where:  { id: tenantId },
      select: { id: true, slug: true, name: true, isActive: true, accountType: true, resellerType: true },
    });
    if (!tenant) throw new NotFoundException('Account not found');
    if (tenant.accountType === 'PLATFORM') {
      throw new BadRequestException("That's the platform account — use the admin panel");
    }
    if (!tenant.isActive) {
      throw new BadRequestException('This account is suspended. Activate it first to view it.');
    }
    await this.prisma.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        userId:   scope.userId,
        action:   'ADMIN_VIEW_AS_STARTED',
        resource: 'tenant',
        resourceId: tenant.id,
        metadata: { tenantName: tenant.name },
      },
    });
    return {
      success: true,
      data: {
        tenantId:    tenant.id,
        tenantSlug:  tenant.slug,
        tenantName:  tenant.name,
        accountType: tenant.accountType,
        redirect:    tenant.accountType === 'RESELLER' ? '/reseller' : '/inbox',
      },
    };
  }

  async stopViewAs(scope: TenantScope) {
    this.guard(scope);
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

  // ── White-label ──────────────────────────────────────────────────────────────

  async getWhiteLabel(scope: TenantScope) {
    this.guard(scope);
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
    const rows = resellers.map((r: any) => ({
      id:          r.id,
      name:        r.name,
      isActive:    r.isActive,
      clients:     r._count.children,
      brand:       r.whiteLabel,
      walletMinor: r.wallet?.balanceMinor ?? 0,
    }));
    return {
      success: true,
      data: {
        config: {
          whiteLabelFeeMinor:  config?.whiteLabelFeeMinor  ?? 0,
          whiteLabelGraceDays: config?.whiteLabelGraceDays ?? 7,
        },
        resellers: rows,
      },
    };
  }

  async updateWhiteLabel(scope: TenantScope, data: { whiteLabelFeeMinor?: number; whiteLabelGraceDays?: number }) {
    this.guard(scope);
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
    data: { action?: string; feeOverrideMinor?: number | null; reason?: string },
  ) {
    this.guard(scope);

    let outcome = 'updated';

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
        const wallet     = await this.prisma.wallet.findUnique({ where: { tenantId } });
        const newBalance = (wallet?.balanceMinor ?? 0) - feeMinor;
        await this.prisma.wallet.upsert({
          where:  { tenantId },
          create: { tenantId, balanceMinor: newBalance },
          update: { balanceMinor: newBalance },
        });
        await this.prisma.walletTransaction.create({
          data: {
            tenantId,
            type:              'DEBIT',
            amountMinor:       -feeMinor,
            balanceAfterMinor: newBalance,
            description:       'White-label monthly fee',
          } as any,
        });
        outcome = `charged_${feeMinor}`;
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
    this.guard(scope);
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
    this.guard(scope);
    const storedSections = await (this.prisma as any).cmsSection.findMany({
      where:   { page: 'home' },
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
    this.guard(scope);
    const section = await (this.prisma as any).cmsSection.findFirst({
      where:   { page: 'home', key },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    return { success: true, data: this.buildEditorSection(key, section) };
  }

  async updateCmsSection(scope: TenantScope, key: string, payload: any) {
    this.guard(scope);
    const itemKinds = Object.keys((payload.items as Record<string, unknown>) ?? {});
    const existing  = await (this.prisma as any).cmsSection.findFirst({ where: { page: 'home', key } });

    const section = existing
      ? await (this.prisma as any).cmsSection.update({
          where: { id: existing.id },
          data:  { isActive: payload.isActive, content: payload.content, itemKinds, updatedById: scope.userId },
        })
      : await (this.prisma as any).cmsSection.create({
          data: { page: 'home', key, isActive: payload.isActive ?? true, content: payload.content ?? {}, itemKinds, updatedById: scope.userId },
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
      where:   { page: 'home', key },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    return { success: true, data: this.buildEditorSection(key, updated) };
  }

  async deleteCmsSection(scope: TenantScope, key: string) {
    this.guard(scope);
    await (this.prisma as any).cmsSection.deleteMany({ where: { page: 'home', key } });
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
    this.guard(scope);
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
    this.guard(scope);
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
    this.guard(scope);
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
    this.guard(scope);
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

  async updateTenantSubscription(scope: TenantScope, tenantId: string, data: { planId?: string; status?: string; currentPeriodEnd?: string }) {
    this.guard(scope);
    return this.prisma.subscription.upsert({
      where: { tenantId },
      create: {
        tenantId,
        planId: data.planId ?? 'free',
        status: (data.status ?? 'ACTIVE') as any,
        currentPeriodStart: new Date(),
        currentPeriodEnd: data.currentPeriodEnd ? new Date(data.currentPeriodEnd) : new Date(Date.now() + 30 * 86400000),
      },
      update: {
        ...(data.planId ? { planId: data.planId } : {}),
        ...(data.status ? { status: data.status as any } : {}),
        ...(data.currentPeriodEnd ? { currentPeriodEnd: new Date(data.currentPeriodEnd) } : {}),
      },
    });
  }

  // ── Tenant WhatsApp ───────────────────────────────────────────────────────────

  async getTenantWhatsApp(scope: TenantScope, tenantId: string) {
    this.guard(scope);
    return this.prisma.whatsAppIntegration.findMany({
      where: { tenantId },
      include: { business: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminWhatsAppAction(scope: TenantScope, tenantId: string, action: string) {
    this.guard(scope);
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
    this.guard(scope);
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
    this.guard(scope);
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
