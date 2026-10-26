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

  // ── Overview ──────────────────────────────────────────────────────────────

  @Get('overview')
  @ApiOperation({ summary: 'Reseller dashboard overview' })
  getOverview(@CurrentTenant() scope: TenantScope) {
    return this.svc.getOverview(scope);
  }

  // ── Branding ──────────────────────────────────────────────────────────────

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
      brandName: string; logoUrl?: string; faviconUrl?: string; primaryColor?: string;
      accentColor?: string; domain?: string; supportEmail?: string; supportPhone?: string;
      website?: string; address?: string; loginHeadline?: string; loginSubtext?: string;
      subdomain?: string; landingEnabled?: boolean; landingTitle?: string;
      landingSubtitle?: string; termsContent?: string; privacyContent?: string;
    },
  ) {
    return this.svc.upsertBranding(scope, body);
  }

  @Get('branding/domain')
  @ApiOperation({ summary: 'Check custom domain DNS status for this reseller' })
  checkDomain(@CurrentTenant() scope: TenantScope) {
    return this.svc.checkDomainStatus(scope);
  }

  @Post('branding/pay')
  @ApiOperation({ summary: 'Charge monthly white-label fee from reseller wallet' })
  payBrandingFee(@CurrentTenant() scope: TenantScope) {
    return this.svc.payBrandingFee(scope);
  }

  // ── Clients ───────────────────────────────────────────────────────────────

  @Get('clients')
  @ApiOperation({ summary: 'List client tenants' })
  listClients(
    @CurrentTenant() scope: TenantScope,
    @Query('page')   page?:   string,
    @Query('limit')  limit?:  string,
    @Query('search') search?: string,
  ) {
    return this.svc.listClients(scope, {
      page:   page  ? Number(page)  : undefined,
      limit:  limit ? Number(limit) : undefined,
      search,
    });
  }

  @Post('clients')
  @ApiOperation({ summary: 'Create a new client tenant under this reseller' })
  createClient(
    @CurrentTenant() scope: TenantScope,
    @Body() body: {
      name: string; ownerName?: string; ownerEmail: string;
      planId: string; trialDays?: number; categoryId?: string | null;
    },
  ) {
    return this.svc.createClient(scope, body);
  }

  @Get('clients/:id')
  @ApiOperation({ summary: 'Get client detail' })
  getClient(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.getClient(scope, id);
  }

  @Patch('clients/:id')
  @ApiOperation({ summary: 'Update client (toggle active, change plan)' })
  updateClient(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { isActive?: boolean; planId?: string },
  ) {
    return this.svc.updateClient(scope, id, body);
  }

  @Get('clients/:id/report')
  @ApiOperation({ summary: 'Client messaging analytics report' })
  getClientReport(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Query('days') days?: string,
  ) {
    return this.svc.getClientReport(scope, id, { days: days ? Number(days) : undefined });
  }

  @Post('clients/:id/wallet')
  @ApiOperation({ summary: 'Transfer credits from reseller wallet to client' })
  transferToClient(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { amountMinor: number; note?: string },
  ) {
    return this.svc.transferToClient(scope, id, body);
  }

  // ── Plans ─────────────────────────────────────────────────────────────────

  @Get('plans')
  @ApiOperation({ summary: 'List reseller plans and available base plans' })
  listPlans(@CurrentTenant() scope: TenantScope) {
    return this.svc.listPlans(scope);
  }

  @Post('plans')
  @ApiOperation({ summary: 'Create a reseller plan from a base plan' })
  createPlan(
    @CurrentTenant() scope: TenantScope,
    @Body() body: {
      displayName: string; description?: string;
      basePlanId: string; priceMonthly: number; priceAnnual?: number;
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
      displayName?: string; description?: string;
      priceMonthly?: number; priceAnnual?: number; isActive?: boolean;
    },
  ) {
    return this.svc.updatePlan(scope, id, body);
  }

  @Delete('plans/:id')
  @ApiOperation({ summary: 'Soft-delete a reseller plan' })
  deletePlan(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.deletePlan(scope, id);
  }

  // ── Rates ─────────────────────────────────────────────────────────────────

  @Get('rates')
  @ApiOperation({ summary: 'List message rates (platform base + reseller overrides)' })
  listRates(@CurrentTenant() scope: TenantScope) {
    return this.svc.listRates(scope);
  }

  @Put('rates')
  @ApiOperation({ summary: 'Set or remove a reseller rate override (null removes it)' })
  upsertRate(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { category: string; priceMinor: number | null },
  ) {
    return this.svc.upsertRate(scope, body);
  }

  // ── Commissions ───────────────────────────────────────────────────────────

  @Get('commissions')
  @ApiOperation({ summary: 'List reseller commissions with totals by status' })
  listCommissions(
    @CurrentTenant() scope: TenantScope,
    @Query('page')   page?:   string,
    @Query('limit')  limit?:  string,
    @Query('status') status?: string,
  ) {
    return this.svc.listCommissions(scope, {
      page:   page  ? Number(page)  : undefined,
      limit:  limit ? Number(limit) : undefined,
      status,
    });
  }

  // ── SMTP ──────────────────────────────────────────────────────────────────

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
      smtpHost?: string | null; smtpPort?: number | null;
      smtpUser?: string | null; smtpPass?: string | null; smtpFrom?: string | null;
    },
  ) {
    return this.svc.updateSmtp(scope, body);
  }

  @Delete('smtp')
  @ApiOperation({ summary: 'Clear reseller SMTP configuration' })
  clearSmtp(@CurrentTenant() scope: TenantScope) {
    return this.svc.clearSmtp(scope);
  }
}
