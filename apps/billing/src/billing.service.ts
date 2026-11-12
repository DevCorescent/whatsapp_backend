import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope, MessageRatesService } from '@lib/common';
import { nextRenewalPeriod } from './renewal-period';

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rates:  MessageRatesService,
  ) {}

  // ── Plans ──────────────────────────────────────────────────────────────────

  async getPublicPlans(resellerId?: string) {
    if (resellerId) {
      const own = await this.prisma.plan.findMany({
        where:   { resellerId, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { priceMonthly: 'asc' }],
        take:    4,
      });
      if (own.length) return { success: true, data: { plans: own } };
    }
    const plans = await this.prisma.plan.findMany({
      where:   { visibility: 'PUBLIC', isActive: true, resellerId: null },
      orderBy: [{ sortOrder: 'asc' }, { priceMonthly: 'asc' }],
      take:    4,
    });
    return { success: true, data: { plans } };
  }

  /**
   * The plans one account may be put on: the platform's public plans, their own
   * reseller's plans if they have one, and any plan priced for them alone.
   *
   * Two things were wrong without this. An account on a custom plan saw a billing page
   * that did not list the plan they were on and offered to "upgrade" them to something
   * smaller; and because a reseller's plans are PUBLIC rows too, every account saw every
   * reseller's plans, including resellers they have nothing to do with.
   */
  private async availablePlans(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where:  { id: tenantId },
      select: { parentId: true },
    });
    return {
      isActive: true,
      OR: [
        { visibility: 'PUBLIC' as const, resellerId: null },
        ...(tenant?.parentId ? [{ resellerId: tenant.parentId }] : []),
        { ownerTenantId: tenantId },
      ],
    };
  }

  /** One plan, only if this account may be put on it. */
  private async planFor(tenantId: string, planId: string) {
    const plan = await this.prisma.plan.findFirst({
      where: { id: planId, ...(await this.availablePlans(tenantId)) },
    });
    if (!plan) throw new NotFoundException('Plan not found');
    return plan;
  }

  async getPlans(scope: TenantScope) {
    const plans = await this.prisma.plan.findMany({
      where:   await this.availablePlans(scope.tenantId),
      orderBy: { sortOrder: 'asc' },
    });

    const billingEnabled = !!(
      process.env['RAZORPAY_KEY_ID']?.trim() &&
      process.env['RAZORPAY_KEY_SECRET']?.trim()
    );

    const sub = await this.prisma.subscription.findUnique({
      where:  { tenantId: scope.tenantId },
      select: { planId: true, status: true },
    });

    return {
      success: true,
      data: {
        plans,
        currentPlanId: sub?.planId ?? null,
        status:        sub?.status ?? 'FREE',
        billingEnabled,
      },
    };
  }

  async getPlanById(id: string) {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Plan not found');
    return plan;
  }

  // ── Billing status (matches Next.js /api/billing GET shape) ──────────────

  async getBillingStatus(scope: TenantScope) {
    const sub = await this.prisma.subscription.findUnique({
      where:   { tenantId: scope.tenantId },
      include: { plan: true },
    });
    if (!sub) throw new NotFoundException('Subscription not found');

    // Messages, campaigns, storage and AI credits were all reported as a flat zero —
    // not "we don't track this" but the number 0 next to a real allowance, so every
    // workspace's billing page said they had sent nothing all month however busy they
    // had been. Counted over the subscription's own period, because that is when the
    // allowance resets.
    const periodStart = sub.currentPeriodStart;
    const [contacts, users, messages, campaigns, storage] = await Promise.all([
      this.prisma.contact.count({ where: { tenantId: scope.tenantId } }),
      this.prisma.user.count({ where: { tenantId: scope.tenantId, removedAt: null } }),
      // What they sent. A message arriving is not something they spend an allowance on,
      // and nor is an internal note, which never leaves the building.
      this.prisma.message.count({
        where: {
          tenantId: scope.tenantId,
          direction: 'OUTBOUND',
          isNote: false,
          createdAt: { gte: periodStart },
        },
      }),
      this.prisma.campaign.count({
        where: { tenantId: scope.tenantId, createdAt: { gte: periodStart } },
      }),
      this.prisma.message.aggregate({
        where: { tenantId: scope.tenantId, mediaSize: { not: null } },
        _sum: { mediaSize: true },
      }),
    ]);

    const plan = (sub as any).plan;
    const storageMb = Math.round((storage._sum.mediaSize ?? 0) / (1024 * 1024));
    // Return flat shape matching Next.js /api/billing (no data wrapper).
    // The TransformInterceptor skips objects that already have a `success` key.
    return {
      success:            true,
      planId:             plan?.id          ?? null,
      planName:           plan?.displayName ?? plan?.name ?? 'Free',
      priceMonthly:       plan?.priceMonthly ?? 0,
      status:             sub.status,
      renewsAt:           sub.currentPeriodEnd,
      cancelAtPeriodEnd:  sub.cancelAtPeriodEnd,
      trialEndsAt:        (sub as any).trialEndsAt ?? null,
      hasStripe:          !!(sub as any).stripeSubId,
      hasRazorpay:        !!(sub as any).razorpaySubId,
      invoices:           [],
      usage: {
        contacts: { label: 'Contacts', used: contacts, limit: plan?.maxContacts ?? 0 },
        agents:   { label: 'Agents',   used: users,    limit: plan?.maxAgents   ?? 0 },
        // "This period", not "this month": the allowance resets when the subscription
        // renews, which for an annual plan is nothing like the first of the month.
        messages: { label: 'Messages sent this period', used: messages, limit: plan?.maxMsgPerMonth ?? 0 },
        campaigns:{ label: 'Campaigns this period', used: campaigns, limit: plan?.maxCampaigns ?? 0 },
        storage:  { label: 'Storage (MB)', used: storageMb, limit: plan?.maxStorageMb ?? 0 },
        ai:       { label: 'AI credits', used: sub.aiCreditsUsed ?? 0, limit: plan?.aiCredits ?? 0 },
      },
    };
  }

  // ── Unified checkout ───────────────────────────────────────────────────────

  async checkout(scope: TenantScope, planId: string) {
    // Only a plan this account may be on. A plan id is guessable, and a plan priced for
    // one customer — possibly at nothing — must not be reachable by anyone else.
    const plan = await this.planFor(scope.tenantId, planId);
    const price = (plan as any).priceMonthly ?? 0;

    if (price <= 0) {
      // Free plan — assign directly
      await this.prisma.subscription.upsert({
        where:  { tenantId: scope.tenantId },
        create: {
          tenantId:          scope.tenantId,
          planId,
          status:            'ACTIVE',
          currentPeriodStart: new Date(),
          currentPeriodEnd:  new Date(Date.now() + 30 * 86400000),
        },
        update: {
          planId,
          status:            'ACTIVE',
          cancelAtPeriodEnd: false,
          cancelledAt:       null,
        },
      });
      return { orderId: null, assigned: true };
    }

    // Paid plan — create Razorpay order
    const razorpayKeyId  = process.env['RAZORPAY_KEY_ID'];
    const razorpaySecret = process.env['RAZORPAY_KEY_SECRET'];
    if (!razorpayKeyId || !razorpaySecret) throw new BadRequestException('Razorpay not configured');

    const authHeader = Buffer.from(`${razorpayKeyId}:${razorpaySecret}`).toString('base64');
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method:  'POST',
      headers: { Authorization: `Basic ${authHeader}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        amount:   price * 100,
        currency: 'INR',
        receipt:  `plan-${scope.tenantId}-${Date.now()}`,
        notes:    { tenantId: scope.tenantId, planId },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new BadRequestException(`Razorpay error: ${err}`);
    }

    const order = await res.json() as any;
    return {
      orderId:  order.id,
      amount:   order.amount,
      currency: (order.currency as string).toUpperCase(),
      keyId:    razorpayKeyId,
      planName: (plan as any).displayName ?? plan.name,
    };
  }

  async createRenewalOrder(scope: TenantScope) {
    const sub = await this.prisma.subscription.findUnique({
      where: { tenantId: scope.tenantId },
      include: { plan: true },
    });
    if (!sub?.plan) throw new NotFoundException('Subscription not found');
    if (sub.currentPeriodEnd <= new Date() || ['EXPIRED', 'PAST_DUE'].includes(sub.status)) {
      throw new BadRequestException('This plan has expired. Choose a plan to subscribe again.');
    }

    const price = Number(sub.billingCycle === 'ANNUAL' ? sub.plan.priceAnnual : sub.plan.priceMonthly);
    if (price <= 0) throw new BadRequestException('Free plans do not need an early renewal');

    const razorpayKeyId = process.env['RAZORPAY_KEY_ID'];
    const razorpaySecret = process.env['RAZORPAY_KEY_SECRET'];
    if (!razorpayKeyId || !razorpaySecret) throw new BadRequestException('Razorpay not configured');

    const authHeader = Buffer.from(`${razorpayKeyId}:${razorpaySecret}`).toString('base64');
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${authHeader}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: Math.round(price * 100),
        currency: 'INR',
        receipt: `renew-${scope.tenantId}-${Date.now()}`,
        notes: {
          tenantId: scope.tenantId,
          planId: sub.planId,
          kind: 'RENEWAL',
          billingCycle: sub.billingCycle,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new BadRequestException(`Razorpay error: ${err}`);
    }

    const order = await res.json() as any;
    return {
      orderId: order.id,
      amount: order.amount,
      currency: (order.currency as string).toUpperCase(),
      keyId: razorpayKeyId,
      planName: (sub.plan as any).displayName ?? sub.plan.name,
    };
  }

  // ── Verify Razorpay payment ────────────────────────────────────────────────

  async verifyRazorpayPayment(
    scope: TenantScope,
    body: {
      razorpay_order_id:   string;
      razorpay_payment_id: string;
      razorpay_signature:  string;
      planId?:             string;
      planChangeId?:       string;
      renewSubscription?:  boolean;
    },
  ) {
    const crypto = await import('crypto');
    const keySecret = process.env['RAZORPAY_KEY_SECRET'] ?? '';
    const expected = crypto
      .createHmac('sha256', keySecret)
      .update(`${body.razorpay_order_id}|${body.razorpay_payment_id}`)
      .digest('hex');

    if (expected !== body.razorpay_signature) {
      throw new BadRequestException('Invalid payment signature');
    }

    if (body.planChangeId) {
      const result = await this.checkoutPlanChange(scope, body.planChangeId);
      return { applied: true, subscription: result };
    }

    if (body.renewSubscription) {
      if (!body.planId) throw new BadRequestException('planId is required for renewal');
      const alreadyApplied = await this.prisma.planRenewalPayment.findUnique({
        where: { razorpayPaymentId: body.razorpay_payment_id },
      });
      if (alreadyApplied) {
        if (alreadyApplied.tenantId !== scope.tenantId) {
          throw new BadRequestException('This payment has already been applied');
        }
        return { applied: true, renewed: true, alreadyApplied: true };
      }

      const razorpayKeyId = process.env['RAZORPAY_KEY_ID'];
      const razorpaySecret = process.env['RAZORPAY_KEY_SECRET'];
      if (!razorpayKeyId || !razorpaySecret) throw new BadRequestException('Razorpay not configured');

      const authHeader = Buffer.from(`${razorpayKeyId}:${razorpaySecret}`).toString('base64');
      const orderResponse = await fetch(
        `https://api.razorpay.com/v1/orders/${encodeURIComponent(body.razorpay_order_id)}`,
        { headers: { Authorization: `Basic ${authHeader}` }, cache: 'no-store' },
      );
      if (!orderResponse.ok) throw new BadRequestException('Unable to verify renewal order');
      const order = await orderResponse.json() as {
        amount: number;
        currency: string;
        status: string;
        notes?: Record<string, string>;
      };
      const currentSubscription = await this.prisma.subscription.findUnique({
        where: { tenantId: scope.tenantId },
        include: { plan: true },
      });
      if (!currentSubscription?.plan || currentSubscription.planId !== body.planId) {
        throw new BadRequestException('The active plan changed before renewal completed. Please try again.');
      }
      const renewalPrice = Number(
        currentSubscription.billingCycle === 'ANNUAL'
          ? currentSubscription.plan.priceAnnual
          : currentSubscription.plan.priceMonthly,
      );
      if (
        order.status !== 'paid' ||
        order.currency !== 'INR' ||
        order.amount !== Math.round(renewalPrice * 100) ||
        order.notes?.tenantId !== scope.tenantId ||
        order.notes?.planId !== body.planId ||
        order.notes?.kind !== 'RENEWAL' ||
        order.notes?.billingCycle !== currentSubscription.billingCycle
      ) {
        throw new BadRequestException('Payment does not match this subscription renewal');
      }

      try {
        const sub = await this.prisma.$transaction(async (tx) => {
          await tx.planRenewalPayment.create({
            data: {
              tenantId: scope.tenantId,
              razorpayPaymentId: body.razorpay_payment_id,
            },
          });
          await tx.$queryRaw`SELECT "tenantId" FROM "subscriptions" WHERE "tenantId" = ${scope.tenantId} FOR UPDATE`;
          const current = await tx.subscription.findUnique({
            where: { tenantId: scope.tenantId },
          });
          if (!current || current.planId !== body.planId || current.billingCycle !== order.notes?.billingCycle) {
            throw new BadRequestException('The active plan changed before renewal completed. Please try again.');
          }
          const now = new Date();
          const period = nextRenewalPeriod(current.currentPeriodEnd, current.billingCycle, now);
          return tx.subscription.update({
            where: { tenantId: scope.tenantId },
            data: {
              status: 'ACTIVE',
              cancelAtPeriodEnd: false,
              cancelledAt: null,
              currentPeriodStart: current.currentPeriodEnd > now ? current.currentPeriodStart : period.startsAt,
              currentPeriodEnd: period.endsAt,
            },
          });
        });
        return { applied: true, renewed: true, subscription: sub };
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') {
          const payment = await this.prisma.planRenewalPayment.findUnique({
            where: { razorpayPaymentId: body.razorpay_payment_id },
          });
          if (payment?.tenantId === scope.tenantId) {
            return { applied: true, renewed: true, alreadyApplied: true };
          }
        }
        throw err;
      }
    }

    if (body.planId) {
      const planId = body.planId;
      const sub = await this.prisma.subscription.upsert({
        where:  { tenantId: scope.tenantId },
        create: {
          tenantId:           scope.tenantId,
          planId,
          status:             'ACTIVE',
          currentPeriodStart: new Date(),
          currentPeriodEnd:   new Date(Date.now() + 30 * 86400000),
        },
        update: {
          planId,
          status:             'ACTIVE',
          cancelAtPeriodEnd:  false,
          cancelledAt:        null,
          currentPeriodStart: new Date(),
          currentPeriodEnd:   new Date(Date.now() + 30 * 86400000),
        },
      });
      return { applied: true, subscription: sub };
    }

    throw new BadRequestException('planId or planChangeId required');
  }

  // ── Subscription ───────────────────────────────────────────────────────────

  async getSubscription(scope: TenantScope) {
    const sub = await this.prisma.subscription.findUnique({
      where:   { tenantId: scope.tenantId },
      include: { plan: true },
    });
    if (!sub) throw new NotFoundException('Subscription not found');
    return sub;
  }

  async cancelSubscription(scope: TenantScope, reason?: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { tenantId: scope.tenantId },
    });
    if (!sub) throw new NotFoundException('Subscription not found');

    const now = new Date();

    if (sub.stripeSubId) {
      const stripeSecretKey = process.env['STRIPE_SECRET_KEY'];
      if (!stripeSecretKey) throw new BadRequestException('Stripe not configured');

      const res = await fetch(
        `https://api.stripe.com/v1/subscriptions/${sub.stripeSubId}`,
        {
          method:  'DELETE',
          headers: {
            Authorization:  `Bearer ${stripeSecretKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ cancel_at_period_end: 'true' }).toString(),
        },
      );

      if (!res.ok) {
        const err = await res.text();
        throw new BadRequestException(`Stripe error: ${err}`);
      }
    }

    return this.prisma.subscription.update({
      where: { tenantId: scope.tenantId },
      data:  { cancelAtPeriodEnd: true, cancelledAt: now },
    });
  }

  async resumeSubscription(scope: TenantScope) {
    const sub = await this.prisma.subscription.findUnique({
      where: { tenantId: scope.tenantId },
    });
    if (!sub) throw new NotFoundException('Subscription not found');
    if (!sub.cancelAtPeriodEnd) {
      throw new BadRequestException('Subscription is not scheduled for cancellation');
    }

    if (sub.stripeSubId) {
      const stripeSecretKey = process.env['STRIPE_SECRET_KEY'];
      if (!stripeSecretKey) throw new BadRequestException('Stripe not configured');

      const res = await fetch(
        `https://api.stripe.com/v1/subscriptions/${sub.stripeSubId}`,
        {
          method:  'POST',
          headers: {
            Authorization:  `Bearer ${stripeSecretKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ cancel_at_period_end: 'false' }).toString(),
        },
      );

      if (!res.ok) {
        const err = await res.text();
        throw new BadRequestException(`Stripe error: ${err}`);
      }
    }

    return this.prisma.subscription.update({
      where: { tenantId: scope.tenantId },
      data:  { cancelAtPeriodEnd: false, cancelledAt: null },
    });
  }

  async getPlanChangeQuote(scope: TenantScope, toPlanId: string, billingCycle?: string) {
    const sub = await this.prisma.subscription.findUnique({
      where:   { tenantId: scope.tenantId },
      include: { plan: true },
    });
    if (!sub) throw new NotFoundException('Subscription not found');

    const targetPlan = await this.planFor(scope.tenantId, toPlanId);

    const now        = new Date();
    const periodEnd  = sub.currentPeriodEnd;
    const periodStart = sub.currentPeriodStart;

    const totalMs     = periodEnd.getTime() - periodStart.getTime();
    const remainingMs = Math.max(0, periodEnd.getTime() - now.getTime());
    const ratio       = totalMs > 0 ? remainingMs / totalMs : 0;

    const currentMonthlyPrice = (sub.plan as any).priceMonthly ?? 0;
    const credit      = ratio * currentMonthlyPrice;
    const amountDue   = Math.max(0, targetPlan.priceMonthly - credit);

    const kind = targetPlan.priceMonthly >= (sub.plan as any).priceMonthly
      ? 'UPGRADE'
      : 'DOWNGRADE';

    const amountDueMinor = Math.max(0, Math.round(amountDue * 100));
    const creditMinor    = Math.round(credit * 100);
    const grantedDays    = kind === 'DOWNGRADE' ? Math.round(remainingMs / 86400000) : null;

    const planChange = await this.prisma.planChange.create({
      data: {
        tenantId:          scope.tenantId,
        fromPlanId:        sub.planId,
        toPlanId,
        kind:              kind as any,
        status:            'PENDING' as any,
        amountDueMinor,
        currency:          'inr',
        resultPeriodStart: now,
        resultPeriodEnd:   periodEnd,
      },
    });

    return {
      id:           planChange.id,
      kind,
      currentPlan:  { id: sub.planId, displayName: (sub.plan as any).displayName ?? (sub.plan as any).name },
      targetPlan:   { id: toPlanId,   displayName: (targetPlan as any).displayName ?? targetPlan.name },
      amountDueMinor,
      amountDue,
      creditMinor,
      credit,
      currency:        'inr',
      effectiveAt:     now.toISOString(),
      periodStart:     sub.currentPeriodStart.toISOString(),
      periodEnd:       periodEnd.toISOString(),
      grantedDays,
      requiresPayment: amountDueMinor > 0,
    };
  }

  async checkoutPlanChange(scope: TenantScope, planChangeId: string) {
    const planChange = await this.prisma.planChange.findFirst({
      where: { id: planChangeId, tenantId: scope.tenantId },
    });
    if (!planChange) throw new NotFoundException('Plan change not found');
    if (planChange.status !== 'PENDING') {
      throw new BadRequestException('Plan change is not in PENDING status');
    }

    if (planChange.amountDueMinor === 0) {
      await this.prisma.$transaction([
        this.prisma.subscription.update({
          where: { tenantId: scope.tenantId },
          data:  { planId: planChange.toPlanId },
        }),
        this.prisma.planChange.update({
          where: { id: planChangeId },
          data:  { status: 'APPLIED' as any, appliedAt: new Date() },
        }),
      ]);
      return {
        applied:    true,
        kind:       planChange.kind,
        grantedDays: planChange.kind === 'DOWNGRADE'
          ? Math.round((planChange.resultPeriodEnd.getTime() - Date.now()) / 86400000)
          : null,
        periodEnd:  planChange.resultPeriodEnd,
      };
    }

    // Paid upgrade — create Razorpay order
    const razorpayKeyId  = process.env['RAZORPAY_KEY_ID'];
    const razorpaySecret = process.env['RAZORPAY_KEY_SECRET'];
    if (!razorpayKeyId || !razorpaySecret) throw new BadRequestException('Razorpay not configured');

    const toPlan = await this.getPlanById(planChange.toPlanId);

    const authHeader = Buffer.from(`${razorpayKeyId}:${razorpaySecret}`).toString('base64');
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method:  'POST',
      headers: { Authorization: `Basic ${authHeader}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        amount:   planChange.amountDueMinor,
        currency: 'INR',
        receipt:  `planchange-${planChangeId}-${Date.now()}`,
        notes:    { tenantId: scope.tenantId, planChangeId },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new BadRequestException(`Razorpay error: ${err}`);
    }

    const order = await res.json() as any;
    return {
      orderId:    order.id,
      amount:     order.amount,
      currency:   (order.currency as string).toUpperCase(),
      keyId:      razorpayKeyId,
      applied:    false,
      kind:       planChange.kind,
      amountDue:  planChange.amountDueMinor / 100,
      planChangeId,
      planName:   (toPlan as any).displayName ?? toPlan.name,
    };
  }

  async getBillingPortal(scope: TenantScope) {
    const sub = await this.prisma.subscription.findUnique({
      where: { tenantId: scope.tenantId },
    });
    if (!sub) throw new NotFoundException('Subscription not found');
    if (!sub.stripeCustomerId) {
      throw new BadRequestException('No Stripe customer');
    }

    const stripeSecretKey = process.env['STRIPE_SECRET_KEY'];
    if (!stripeSecretKey) throw new BadRequestException('Stripe not configured');
    const appUrl = process.env['APP_URL'] ?? 'http://localhost:3000';

    const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        customer:   sub.stripeCustomerId,
        return_url: `${appUrl}/billing`,
      }).toString(),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new BadRequestException(`Stripe error: ${err}`);
    }

    const session = await res.json() as any;
    return { url: session.url };
  }

  // ── Wallet ─────────────────────────────────────────────────────────────────

  /**
   * Everything the wallet screen renders: balance, the prices this account is charged per
   * message, and the first page of the statement.
   *
   * It used to return the bare wallet row, so `rates`, `canTopUp` and `transactions` were
   * all undefined on the client and the page threw on the first `.map`.
   */
  /**
   * Whether this account may top up its own wallet, and why not when it may not.
   *
   * Three things have to line up and they fail for different reasons, so each is named:
   * the platform's master switch (off while payment is still being set up), the plan
   * (a commercial decision per tier), and payment keys actually being configured.
   */
  async walletAccess(tenantId: string): Promise<{ enabled: boolean; reason: string | null }> {
    const [platform, sub] = await Promise.all([
      this.prisma.tenant.findFirst({
        where:  { accountType: 'PLATFORM' },
        select: { settings: { select: { walletEnabled: true } } },
      }),
      this.prisma.subscription.findUnique({
        where:  { tenantId },
        select: { plan: { select: { walletEnabled: true, displayName: true } } },
      }),
    ]);

    if (!platform?.settings?.walletEnabled) {
      return { enabled: false, reason: 'Wallet top-ups are not switched on for this platform yet.' };
    }
    if (!sub?.plan?.walletEnabled) {
      return {
        enabled: false,
        reason: `Your ${sub?.plan?.displayName ?? 'current'} plan does not include a wallet. Change plan to add one.`,
      };
    }
    if (!process.env['RAZORPAY_KEY_ID'] || !process.env['RAZORPAY_KEY_SECRET']) {
      return { enabled: false, reason: 'Online payment is not configured yet.' };
    }
    return { enabled: true, reason: null };
  }

  async getWallet(scope: TenantScope, query: { page?: number; limit?: number } = {}) {
    const page  = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Number(query.limit) || 20);

    const [wallet, rates, access] = await Promise.all([
      this.prisma.wallet.findUnique({ where: { tenantId: scope.tenantId } }),
      this.rates.resolveAll(scope.tenantId),
      this.walletAccess(scope.tenantId),
    ]);
    if (!wallet) throw new NotFoundException('Wallet not found');

    const [transactions, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where:   { tenantId: scope.tenantId },
        skip:    (page - 1) * limit,
        take:    limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.walletTransaction.count({ where: { tenantId: scope.tenantId } }),
    ]);

    const described = await this.nameCampaignRows(transactions);

    return {
      success: true,
      data: {
        // A balance is never negative (DB CHECK + WalletService); clamped here so even a
        // legacy row from before that invariant can't render as debt.
        balanceMinor:             Math.max(0, wallet.balanceMinor),
        lowBalanceThresholdMinor: wallet.lowBalanceThresholdMinor,
        currency:                 (wallet as { currency?: string }).currency ?? 'INR',
        canTopUp:                 access.enabled,
        // Named rather than merely false, so the screen can say which switch is off
        // instead of leaving someone to guess why the button is missing.
        topUpBlockedReason:       access.reason,
        rates: rates.map(r => ({
          category:   r.category,
          priceMinor: r.source === 'unpriced' ? null : r.priceMinor,
          source:     r.source,
        })),
        transactions: described,
      },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /**
   * Where the wallet money went.
   *
   * The ledger already records every debit, but one row per message means a campaign of
   * ten thousand is ten thousand lines and no answer to "what did that campaign cost".
   * This groups the same rows the statement shows, so the two always agree — a separate
   * tally would drift the first time a send was retried.
   *
   * Campaign spend is joined back through the recipient row rather than read from
   * Campaign.costMinor, for the same reason: one source, not two.
   */
  /**
   * Replaces "Campaign message: cmv…" with the campaign's name.
   *
   * The ledger stores an id because a name can change and the debit must still point at
   * the right thing; the statement shows the name because an id tells a person nothing.
   * Looked up per page, so a campaign renamed later reads correctly here too.
   */
  private async nameCampaignRows<T extends { referenceType: string | null; referenceId: string | null; description: string | null }>(
    rows: T[],
  ): Promise<T[]> {
    const recipientIds = rows
      .filter((r) => r.referenceType === 'campaign_message' && r.referenceId)
      .map((r) => r.referenceId!);
    if (!recipientIds.length) return rows;

    const recipients = await this.prisma.campaignContact.findMany({
      where:  { id: { in: recipientIds } },
      select: { id: true, campaign: { select: { name: true } } },
    });
    const nameById = new Map(recipients.map((r) => [r.id, r.campaign?.name]));

    return rows.map((r) => {
      const name = r.referenceId ? nameById.get(r.referenceId) : undefined;
      return name ? { ...r, description: `Campaign message · ${name}` } : r;
    });
  }

  async getWalletSpend(scope: TenantScope, query: { from?: string; to?: string } = {}) {
    const from = query.from ? new Date(query.from) : new Date(Date.now() - 30 * 86_400_000);
    const to   = query.to   ? new Date(query.to)   : new Date();

    const where = {
      tenantId:  scope.tenantId,
      createdAt: { gte: from, lte: to },
    };

    // Totals by what the money was for. Credits and debits are kept apart because
    // netting them hides both — "spent 5,000, topped up 5,000" is not "spent nothing".
    const grouped = await this.prisma.walletTransaction.groupBy({
      by:     ['referenceType'],
      where,
      _sum:   { amountMinor: true },
      _count: { _all: true },
    });

    const byReason = grouped.map((g) => ({
      reason: g.referenceType ?? 'other',
      count:  g._count._all,
      // Debits are stored negative; reported as a positive amount spent.
      amountMinor: Math.abs(g._sum.amountMinor ?? 0),
      direction: (g._sum.amountMinor ?? 0) < 0 ? ('debit' as const) : ('credit' as const),
    }));

    const spentMinor  = byReason.filter((r) => r.direction === 'debit').reduce((a, r) => a + r.amountMinor, 0);
    const toppedUpMinor = byReason.filter((r) => r.direction === 'credit').reduce((a, r) => a + r.amountMinor, 0);

    // Per campaign, through the recipient rows the debits point at.
    const byCampaign = await this.prisma.$queryRaw<Array<{
      campaignId: string; name: string; messages: number; spentMinor: number; lastSentAt: Date | null;
    }>>`
      SELECT c.id                               AS "campaignId",
             c.name                             AS name,
             COUNT(*)::int                      AS messages,
             SUM(ABS(wt."amountMinor"))::int    AS "spentMinor",
             MAX(wt."createdAt")                AS "lastSentAt"
        FROM wallet_transactions wt
        JOIN campaign_contacts cc ON cc.id = wt."referenceId"
        JOIN campaigns c          ON c.id  = cc."campaignId"
       WHERE wt."tenantId" = ${scope.tenantId}
         AND wt."referenceType" = 'campaign_message'
         AND wt."createdAt" BETWEEN ${from} AND ${to}
       GROUP BY c.id, c.name
       ORDER BY SUM(ABS(wt."amountMinor")) DESC
       LIMIT 100`;

    const wallet = await this.prisma.wallet.findUnique({ where: { tenantId: scope.tenantId } });

    return {
      from, to,
      balanceMinor: Math.max(0, wallet?.balanceMinor ?? 0),
      spentMinor,
      toppedUpMinor,
      byReason,
      byCampaign,
    };
  }

  async getWalletTransactions(scope: TenantScope, query: { page?: number; limit?: number }) {
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const skip  = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where:   { tenantId: scope.tenantId },
        skip, take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.walletTransaction.count({ where: { tenantId: scope.tenantId } }),
    ]);

    return { transactions, total, page, limit };
  }

  async updateWalletThreshold(scope: TenantScope, thresholdMinor: number) {
    return this.prisma.wallet.update({
      where: { tenantId: scope.tenantId },
      data:  { lowBalanceThresholdMinor: thresholdMinor },
    });
  }

  // ── Razorpay checkout ──────────────────────────────────────────────────────

  /**
   * A top-up order, refused with the specific reason when the wallet is not available.
   *
   * Guarded here rather than only in the interface: the button being hidden is a
   * courtesy, not a control.
   */
  async createWalletTopUpOrder(scope: TenantScope, amountMinor: number, currency?: string) {
    const access = await this.walletAccess(scope.tenantId);
    if (!access.enabled) throw new BadRequestException(access.reason ?? 'Wallet top-ups are unavailable.');
    return this.createRazorpayOrder(scope, amountMinor, currency);
  }

  async createRazorpayOrder(scope: TenantScope, amountMinor: number, currency = 'INR') {
    if (amountMinor <= 0) throw new BadRequestException('Amount must be positive');

    const razorpayKeyId  = process.env['RAZORPAY_KEY_ID'];
    const razorpaySecret = process.env['RAZORPAY_KEY_SECRET'];
    if (!razorpayKeyId || !razorpaySecret) throw new BadRequestException('Razorpay not configured');

    const auth = Buffer.from(`${razorpayKeyId}:${razorpaySecret}`).toString('base64');
    const res  = await fetch('https://api.razorpay.com/v1/orders', {
      method:  'POST',
      headers: {
        Authorization:  `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount:          amountMinor,
        currency,
        receipt:         `wallet-${scope.tenantId}-${Date.now()}`,
        notes:           { tenantId: scope.tenantId },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new BadRequestException(`Razorpay error: ${err}`);
    }

    return res.json();
  }

  // ── Razorpay webhook ───────────────────────────────────────────────────────

  async handleRazorpayWebhook(rawBody: string, signature: string) {
    const crypto = await import('crypto');
    const secret = process.env['RAZORPAY_WEBHOOK_SECRET'] ?? '';
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      throw new BadRequestException('Invalid webhook signature');
    }

    const event = JSON.parse(rawBody) as any;
    if (event.event === 'payment.captured') {
      await this.applyRazorpayPayment(event.payload?.payment?.entity);
    }

    return { ok: true };
  }

  private async applyRazorpayPayment(payment: any) {
    if (!payment) return;
    const tenantId    = payment.notes?.tenantId as string;
    const amountMinor = payment.amount as number;
    if (!tenantId || !amountMinor) return;

    const idempotencyKey = `razorpay:${payment.id}`;
    const existing = await this.prisma.walletTransaction.findUnique({ where: { idempotencyKey } });
    if (existing) return; // already applied

    await this.prisma.$transaction(async tx => {
      const wallet = await tx.wallet.upsert({
        where:  { tenantId },
        create: { tenantId, balanceMinor: 0 },
        update: {},
      });
      const newBalance = wallet.balanceMinor + amountMinor;
      await tx.wallet.update({ where: { tenantId }, data: { balanceMinor: newBalance } });
      await tx.walletTransaction.create({
        data: {
          tenantId,
          type:             'TOPUP',
          amountMinor,
          balanceAfterMinor: newBalance,
          description:      `Razorpay payment ${payment.id}`,
          referenceType:    'razorpay_payment',
          referenceId:      payment.id,
          idempotencyKey,
        },
      });
    });
  }

  // ── Stripe checkout ────────────────────────────────────────────────────────

  async createStripeCheckout(scope: TenantScope, planId: string, billingCycle: 'MONTHLY' | 'ANNUAL') {
    const plan = await this.planFor(scope.tenantId, planId);
    if (!plan.stripePriceId) throw new BadRequestException('Plan does not have a Stripe price');

    const stripeSecretKey = process.env['STRIPE_SECRET_KEY'];
    if (!stripeSecretKey) throw new BadRequestException('Stripe not configured');

    const price  = billingCycle === 'ANNUAL' ? plan.priceAnnual : plan.priceMonthly;
    const appUrl = process.env['APP_URL'] ?? 'http://localhost:3000';

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        mode:                'subscription',
        'line_items[0][price]':    plan.stripePriceId,
        'line_items[0][quantity]': '1',
        success_url: `${appUrl}/dashboard/billing?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${appUrl}/dashboard/billing`,
        'metadata[tenantId]':     scope.tenantId,
        'metadata[planId]':       planId,
        'metadata[billingCycle]': billingCycle,
      }).toString(),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new BadRequestException(`Stripe error: ${err}`);
    }

    const session = await res.json() as any;
    return { url: session.url, sessionId: session.id };
  }

  // ── Stripe webhook ─────────────────────────────────────────────────────────

  async handleStripeWebhook(rawBody: string, signature: string) {
    const crypto     = await import('crypto');
    const secret     = process.env['STRIPE_WEBHOOK_SECRET'] ?? '';
    const parts      = signature.split(',').reduce<Record<string, string>>((acc, p) => {
      const [k, v] = p.split('=');
      acc[k] = v;
      return acc;
    }, {});
    const ts      = parts['t'];
    const sigHash = parts['v1'];
    const payload = `${ts}.${rawBody}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    if (!sigHash || sigHash !== expected) {
      throw new BadRequestException('Invalid Stripe signature');
    }

    const event = JSON.parse(rawBody) as any;
    if (event.type === 'checkout.session.completed') {
      await this.applyStripeCheckout(event.data?.object);
    }

    return { ok: true };
  }

  private async applyStripeCheckout(session: any) {
    if (!session) return;
    const tenantId    = session.metadata?.tenantId as string;
    const planId      = session.metadata?.planId as string;
    const billingCycle = (session.metadata?.billingCycle ?? 'MONTHLY') as string;
    if (!tenantId || !planId) return;

    const idempotencyKey = `stripe:session:${session.id}`;
    const existing = await this.prisma.walletTransaction.findUnique({ where: { idempotencyKey } });
    if (existing) return;

    const now = new Date();
    const end = billingCycle === 'ANNUAL'
      ? new Date(now.getFullYear() + 1, now.getMonth(), now.getDate())
      : new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());

    await this.prisma.subscription.upsert({
      where:  { tenantId },
      create: {
        tenantId,
        planId,
        status:             'ACTIVE',
        billingCycle:       billingCycle as any,
        currentPeriodStart: now,
        currentPeriodEnd:   end,
        stripeCustomerId:   session.customer,
        stripeSubId:        session.subscription,
      },
      update: {
        planId,
        status:             'ACTIVE',
        billingCycle:       billingCycle as any,
        currentPeriodStart: now,
        currentPeriodEnd:   end,
        stripeCustomerId:   session.customer,
        stripeSubId:        session.subscription,
      },
    });

    // Record a sentinel tx so we deduplicate future replays
    const wallet = await this.prisma.wallet.upsert({
      where:  { tenantId },
      create: { tenantId, balanceMinor: 0 },
      update: {},
    });
    await this.prisma.walletTransaction.create({
      data: {
        tenantId,
        type:              'ADJUSTMENT',
        amountMinor:       0,
        balanceAfterMinor: wallet.balanceMinor,
        description:       `Stripe plan activation ${session.id}`,
        referenceType:     'stripe_session',
        referenceId:       session.id,
        idempotencyKey,
      },
    });
  }
}
