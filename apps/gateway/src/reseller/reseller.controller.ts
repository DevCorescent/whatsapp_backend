import {
  Controller, Get, Post, Put, Patch, Delete,
  Body, Param, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { ResellerService } from './reseller.service';

@ApiTags('reseller')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('reseller')
export class ResellerController {
  constructor(private readonly svc: ResellerService) {}

  // ── Overview ────────────────────────────────────────────────────────────────

  @Get('overview')
  @ApiOperation({ summary: 'Reseller dashboard overview' })
  getOverview(@CurrentTenant() scope: TenantScope) {
    return this.svc.getOverview(scope);
  }

  // ── Branding ────────────────────────────────────────────────────────────────

  @Get('branding')
  @ApiOperation({ summary: 'Get white-label branding config' })
  getBranding(@CurrentTenant() scope: TenantScope) {
    return this.svc.getBranding(scope);
  }

  @Put('branding')
  @ApiOperation({ summary: 'Upsert white-label branding config' })
  upsertBranding(
    @CurrentTenant() scope: TenantScope,
    @Body() body: {
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
    },
  ) {
    return this.svc.upsertBranding(scope, body);
  }

  @Get('branding/domain')
  @ApiOperation({ summary: 'Check if a custom domain is available' })
  checkDomain(@CurrentTenant() scope: TenantScope, @Query('domain') domain: string) {
    return this.svc.checkDomainAvailable(scope, domain);
  }

  // ── Clients ─────────────────────────────────────────────────────────────────

  @Get('clients')
  @ApiOperation({ summary: 'List child tenants (clients)' })
  listClients(
    @CurrentTenant() scope: TenantScope,
    @Query('page')  page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.listClients(scope, {
      page:  page  ? Number(page)  : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('clients/:id')
  @ApiOperation({ summary: 'Get a client tenant with wallet and subscription' })
  getClient(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.getClient(scope, id);
  }

  @Patch('clients/:id')
  @ApiOperation({ summary: 'Update a client tenant' })
  updateClient(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { isActive?: boolean; commissionRate?: number },
  ) {
    return this.svc.updateClient(scope, id, body);
  }

  // ── Plans ────────────────────────────────────────────────────────────────────

  @Get('plans')
  @ApiOperation({ summary: 'List reseller plans' })
  listPlans(@CurrentTenant() scope: TenantScope) {
    return this.svc.listPlans(scope);
  }

  @Post('plans')
  @ApiOperation({ summary: 'Create a reseller plan' })
  createPlan(
    @CurrentTenant() scope: TenantScope,
    @Body() body: {
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
    },
  ) {
    return this.svc.createPlan(scope, body);
  }

  @Patch('plans/:id')
  @ApiOperation({ summary: 'Update a reseller plan' })
  updatePlan(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: {
      name?: string;
      displayName?: string;
      description?: string;
      priceMonthly?: number;
      priceAnnual?: number;
    },
  ) {
    return this.svc.updatePlan(scope, id, body);
  }

  @Delete('plans/:id')
  @ApiOperation({ summary: 'Soft-delete a reseller plan (sets isActive=false)' })
  deletePlan(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.deletePlan(scope, id);
  }

  // ── Rates ─────────────────────────────────────────────────────────────────────

  @Get('rates')
  @ApiOperation({ summary: 'List reseller message rates' })
  listRates(@CurrentTenant() scope: TenantScope) {
    return this.svc.listRates(scope);
  }

  @Put('rates')
  @ApiOperation({ summary: 'Upsert a reseller message rate' })
  upsertRate(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { category: string; priceMinor: number },
  ) {
    return this.svc.upsertRate(scope, body);
  }

  // ── Commissions ───────────────────────────────────────────────────────────────

  @Get('commissions')
  @ApiOperation({ summary: 'List reseller commissions' })
  listCommissions(
    @CurrentTenant() scope: TenantScope,
    @Query('page')   page?: string,
    @Query('limit')  limit?: string,
    @Query('status') status?: string,
  ) {
    return this.svc.listCommissions(scope, {
      page:   page  ? Number(page)  : undefined,
      limit:  limit ? Number(limit) : undefined,
      status,
    });
  }

  // ── SMTP ──────────────────────────────────────────────────────────────────────

  @Get('smtp')
  @ApiOperation({ summary: 'Get reseller SMTP configuration' })
  getSmtp(@CurrentTenant() scope: TenantScope) {
    return this.svc.getSmtp(scope);
  }

  @Put('smtp')
  @ApiOperation({ summary: 'Update reseller SMTP configuration' })
  updateSmtp(
    @CurrentTenant() scope: TenantScope,
    @Body() body: {
      smtpHost?: string;
      smtpPort?: number;
      smtpUser?: string;
      smtpPass?: string;
      smtpFrom?: string;
    },
  ) {
    return this.svc.updateSmtp(scope, body);
  }

  @Delete('smtp')
  @ApiOperation({ summary: 'Clear reseller SMTP configuration' })
  clearSmtp(@CurrentTenant() scope: TenantScope) {
    return this.svc.clearSmtp(scope);
  }

  // ── Client Report ─────────────────────────────────────────────────────────────

  @Get('clients/:id/report')
  @ApiOperation({ summary: 'Client messaging analytics report' })
  getClientReport(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.getClientReport(scope, id);
  }

  // ── Client Wallet Transfer ────────────────────────────────────────────────────

  @Post('clients/:id/wallet')
  @ApiOperation({ summary: 'Transfer credits from reseller wallet to client' })
  transferToClient(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { amountMinor: number; note?: string },
  ) {
    return this.svc.transferToClient(scope, id, body);
  }

  // ── Branding Fee ──────────────────────────────────────────────────────────────

  @Post('branding/pay')
  @ApiOperation({ summary: 'Charge monthly white-label fee from reseller wallet' })
  payBrandingFee(@CurrentTenant() scope: TenantScope) {
    return this.svc.payBrandingFee(scope);
  }
}
