import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Plans ──────────────────────────────────────────────────────────────────

  async getPlans(scope: TenantScope) {
    const plans = await this.prisma.plan.findMany({
      where:   { isActive: true, visibility: 'PUBLIC' },
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

    // Basic usage counters
    const [contacts, users] = await Promise.all([
      this.prisma.contact.count({ where: { tenantId: scope.tenantId } }),
      this.prisma.user.count({ where: { tenantId: scope.tenantId } }),
    ]);

    const plan = (sub as any).plan;
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
        messages: { label: 'Messages this month', used: 0, limit: plan?.maxMsgPerMonth ?? 0 },
        campaigns:{ label: 'Campaigns', used: 0, limit: plan?.maxCampaigns ?? 0 },
        storage:  { label: 'Storage (MB)', used: 0, limit: 0 },
        ai:       { label: 'AI credits', used: 0, limit: 0 },
      },
    };
  }

  // ── Unified checkout ───────────────────────────────────────────────────────

  async checkout(scope: TenantScope, planId: string) {
    const plan = await this.getPlanById(planId);
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

  // ── Verify Razorpay payment ────────────────────────────────────────────────

  async verifyRazorpayPayment(
    scope: TenantScope,
    body: {
      razorpay_order_id:   string;
      razorpay_payment_id: string;
      razorpay_signature:  string;
      planId?:             string;
      planChangeId?:       string;
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

    const targetPlan = await this.getPlanById(toPlanId);

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

  async getWallet(scope: TenantScope) {
    const wallet = await this.prisma.wallet.findUnique({ where: { tenantId: scope.tenantId } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    return wallet;
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
    const plan = await this.getPlanById(planId);
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
