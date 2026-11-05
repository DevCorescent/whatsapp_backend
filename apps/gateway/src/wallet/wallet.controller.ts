import {
  Controller, Get, Patch, Post, Body, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope, PermissionGuard, RequiresPermission } from '@lib/common';
import { BillingService } from '../../../../apps/billing/src/billing.service';

/**
 * URL alias for /billing/wallet* — Next.js exposes the wallet at /api/wallet
 * but NestJS put it under /billing/wallet. Re-exposed here so the proxy needs
 * no special-case rewriting.
 */
@ApiTags('wallet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequiresPermission('billing.manage')
@Controller('wallet')
export class WalletController {
  constructor(private readonly svc: BillingService) {}

  @Get()
  get(
    @CurrentTenant() scope: TenantScope,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.svc.getWallet(scope, { page, limit });
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

  @Get('spend')
  @ApiOperation({ summary: 'Where the wallet money went, and what each campaign cost' })
  spend(
    @CurrentTenant() scope: TenantScope,
    @Query('from') from?: string,
    @Query('to')   to?: string,
  ) {
    return this.svc.getWalletSpend(scope, { from, to });
  }

  @Post('topup')
  topup(
    @CurrentTenant() scope: TenantScope,
    @Body('amountMinor') amountMinor: number,
    @Body('currency') currency?: string,
  ) {
    return this.svc.createWalletTopUpOrder(scope, amountMinor, currency);
  }
}
