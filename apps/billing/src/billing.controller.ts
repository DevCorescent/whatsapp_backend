import {
  Controller, Get, Post, Patch, Body, Query, Headers, RawBody,
  UseGuards, HttpCode, HttpStatus, Req,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { BillingService } from './billing.service';

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly svc: BillingService) {}

  // ── Public: plans list ─────────────────────────────────────────────────────

  @Get('plans')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List available plans' })
  getPlans(@CurrentTenant() scope: TenantScope) {
    return this.svc.getPlans(scope);
  }

  // ── Authenticated endpoints ────────────────────────────────────────────────

  /**
   * GET /billing — unified billing status matching Next.js /api/billing shape.
   * Returns subscription info + usage for the current tenant.
   */
  @Get()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get full billing status (plan, usage, invoices)' })
  getBilling(@CurrentTenant() scope: TenantScope) {
    return this.svc.getBillingStatus(scope);
  }

  @Get('subscription')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get current subscription' })
  getSubscription(@CurrentTenant() scope: TenantScope) {
    return this.svc.getSubscription(scope);
  }

  /**
   * POST /billing/checkout — unified checkout.
   * Free plan: assigns directly. Paid plan: creates Razorpay order.
   */
  @Post('checkout')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Checkout a plan (free assignment or Razorpay order)' })
  checkout(
    @CurrentTenant() scope: TenantScope,
    @Body('planId') planId: string,
  ) {
    return this.svc.checkout(scope, planId);
  }

  /**
   * POST /billing/verify-payment — verify a Razorpay payment signature and
   * activate the subscription or apply a plan change.
   */
  @Post('verify-payment')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Verify Razorpay payment and activate subscription' })
  verifyPayment(
    @CurrentTenant() scope: TenantScope,
    @Body() body: {
      razorpay_order_id:   string;
      razorpay_payment_id: string;
      razorpay_signature:  string;
      planId?:             string;
      planChangeId?:       string;
    },
  ) {
    return this.svc.verifyRazorpayPayment(scope, body);
  }

  @Post('cancel')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Cancel subscription at period end' })
  cancelSubscription(
    @CurrentTenant() scope: TenantScope,
    @Body('reason') reason?: string,
  ) {
    return this.svc.cancelSubscription(scope, reason);
  }

  @Post('resume')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Resume a subscription scheduled for cancellation' })
  resumeSubscription(@CurrentTenant() scope: TenantScope) {
    return this.svc.resumeSubscription(scope);
  }

  @Get('change')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get a proration quote for a plan change' })
  getPlanChangeQuote(
    @CurrentTenant() scope: TenantScope,
    @Query('planId') planId: string,
    @Query('cycle')  cycle?: string,
  ) {
    return this.svc.getPlanChangeQuote(scope, planId, cycle);
  }

  @Post('change')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Checkout / apply a pending plan change' })
  checkoutPlanChange(
    @CurrentTenant() scope: TenantScope,
    @Body('planChangeId') planChangeId: string,
  ) {
    return this.svc.checkoutPlanChange(scope, planChangeId);
  }

  @Post('portal')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Create a Stripe billing portal session' })
  getBillingPortal(@CurrentTenant() scope: TenantScope) {
    return this.svc.getBillingPortal(scope);
  }

  @Get('wallet')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get wallet balance' })
  getWallet(@CurrentTenant() scope: TenantScope) {
    return this.svc.getWallet(scope);
  }

  @Get('wallet/transactions')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List wallet transactions' })
  getWalletTransactions(
    @CurrentTenant() scope: TenantScope,
    @Query('page')  page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.getWalletTransactions(scope, {
      page:  page  ? Number(page)  : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Patch('wallet')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Update wallet low-balance alert threshold' })
  updateWalletThreshold(
    @CurrentTenant() scope: TenantScope,
    @Body('thresholdMinor') thresholdMinor: number,
  ) {
    return this.svc.updateWalletThreshold(scope, thresholdMinor);
  }

  @Post('razorpay/order')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Create a Razorpay order for wallet top-up' })
  createRazorpayOrder(
    @CurrentTenant() scope: TenantScope,
    @Body('amountMinor') amountMinor: number,
    @Body('currency')    currency?: string,
  ) {
    return this.svc.createRazorpayOrder(scope, amountMinor, currency);
  }

  @Post('stripe/checkout')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Create a Stripe checkout session for plan purchase' })
  createStripeCheckout(
    @CurrentTenant() scope: TenantScope,
    @Body('planId')      planId: string,
    @Body('billingCycle') billingCycle: 'MONTHLY' | 'ANNUAL',
  ) {
    return this.svc.createStripeCheckout(scope, planId, billingCycle ?? 'MONTHLY');
  }

  // ── Webhooks (no auth — verified by signature) ────────────────────────────

  @Post('webhooks/razorpay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Razorpay payment webhook' })
  async razorpayWebhook(
    @Req() req: any,
    @Headers('x-razorpay-signature') sig: string,
  ) {
    const rawBody = req.rawBody ?? JSON.stringify(req.body);
    return this.svc.handleRazorpayWebhook(rawBody, sig ?? '');
  }

  @Post('webhooks/stripe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stripe payment webhook' })
  async stripeWebhook(
    @Req() req: any,
    @Headers('stripe-signature') sig: string,
  ) {
    const rawBody = req.rawBody ?? JSON.stringify(req.body);
    return this.svc.handleStripeWebhook(rawBody, sig ?? '');
  }
}
