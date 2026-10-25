import {
  Controller, Get, Post, Patch, Body, Query, Headers, Req,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { BillingService } from '../../../../apps/billing/src/billing.service';

/**
 * Gateway billing proxy — forwards all /billing/* routes to BillingService
 * so the frontend can reach billing without switching ports.
 */
@ApiTags('billing')
@Controller('billing')
export class GatewayBillingController {
  constructor(private readonly svc: BillingService) {}

  @Get('plans/public')
  @ApiOperation({ summary: 'List public plans for landing page (no auth)' })
  getPublicPlans(@Query('resellerId') resellerId?: string) {
    return this.svc.getPublicPlans(resellerId);
  }

  @Get('plans')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List available plans' })
  getPlans(@CurrentTenant() scope: TenantScope) {
    return this.svc.getPlans(scope);
  }

  @Get()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get billing status (plan, usage, invoices)' })
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

  @Post('checkout')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Checkout a plan' })
  checkout(@CurrentTenant() scope: TenantScope, @Body('planId') planId: string) {
    return this.svc.checkout(scope, planId);
  }

  @Post('verify-payment')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Verify Razorpay payment' })
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
  cancelSubscription(@CurrentTenant() scope: TenantScope, @Body('reason') reason?: string) {
    return this.svc.cancelSubscription(scope, reason);
  }

  @Post('resume')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  resumeSubscription(@CurrentTenant() scope: TenantScope) {
    return this.svc.resumeSubscription(scope);
  }

  @Get('change')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  getPlanChangeQuote(
    @CurrentTenant() scope: TenantScope,
    @Query('planId') planId: string,
    @Query('cycle') cycle?: string,
  ) {
    return this.svc.getPlanChangeQuote(scope, planId, cycle);
  }

  @Post('change')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  checkoutPlanChange(@CurrentTenant() scope: TenantScope, @Body('planChangeId') id: string) {
    return this.svc.checkoutPlanChange(scope, id);
  }

  @Post('razorpay/order')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  createRazorpayOrder(
    @CurrentTenant() scope: TenantScope,
    @Body('amountMinor') amountMinor: number,
    @Body('currency') currency?: string,
  ) {
    return this.svc.createRazorpayOrder(scope, amountMinor, currency);
  }

  @Post('stripe/checkout')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  createStripeCheckout(
    @CurrentTenant() scope: TenantScope,
    @Body('planId') planId: string,
    @Body('billingCycle') billingCycle: 'MONTHLY' | 'ANNUAL',
  ) {
    return this.svc.createStripeCheckout(scope, planId, billingCycle ?? 'MONTHLY');
  }

  @Post('portal')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get billing portal URL' })
  getBillingPortal(@CurrentTenant() scope: TenantScope) {
    return this.svc.getBillingPortal(scope);
  }
}
