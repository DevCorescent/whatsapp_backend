import {
  Controller, Get, Patch, Post, Body, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { BillingService } from '../../../../apps/billing/src/billing.service';

/**
 * URL alias for /billing/wallet* — Next.js exposes the wallet at /api/wallet
 * but NestJS put it under /billing/wallet. Re-exposed here so the proxy needs
 * no special-case rewriting.
 */
@ApiTags('wallet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('wallet')
export class WalletController {
  constructor(private readonly svc: BillingService) {}

  @Get()
  get(
    @CurrentTenant() scope: TenantScope,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.svc.getWallet(scope);
  }

  @Get('transactions')
  transactions(
    @CurrentTenant() scope: TenantScope,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.svc.getWalletTransactions(scope, { page, limit });
  }

  @Patch()
  updateThreshold(
    @CurrentTenant() scope: TenantScope,
    @Body('thresholdMinor') thresholdMinor: number,
  ) {
    return this.svc.updateWalletThreshold(scope, thresholdMinor);
  }

  @Post('topup')
  topup(
    @CurrentTenant() scope: TenantScope,
    @Body('amountMinor') amountMinor: number,
    @Body('currency') currency?: string,
  ) {
    return this.svc.createRazorpayOrder(scope, amountMinor, currency);
  }
}
