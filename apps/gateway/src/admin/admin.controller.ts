import {
  Controller, Get, Post, Patch, Put, Delete, Body, Param, Query, UseGuards, Res, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { Response } from 'express';
import { AdminService } from './admin.service';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly svc: AdminService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Platform-wide stats (super admin)' })
  stats(@CurrentTenant() scope: TenantScope) {
    return this.svc.getStats(scope);
  }

  @Get('revenue')
  @ApiOperation({ summary: 'Revenue summary (super admin)' })
  revenue(@CurrentTenant() scope: TenantScope, @Query('range') range?: string) {
    return this.svc.getRevenue(scope, { range });
  }

  @Get('revenue/export')
  @ApiOperation({ summary: 'Revenue CSV export (super admin)' })
  async revenueExport(
    @CurrentTenant() scope: TenantScope,
    @Res() res: Response,
    @Query('days') days?: string,
  ) {
    const csv = await this.svc.getRevenueExport(scope, { days: days ? Number(days) : undefined });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="revenue-export.csv"');
    res.send(csv);
  }

  @Get('tenants')
  @ApiOperation({ summary: 'List all tenants (super admin)' })
  listTenants(
    @CurrentTenant() scope: TenantScope,
    @Query('page')        page?: string,
    @Query('limit')       limit?: string,
    @Query('search')      search?: string,
    @Query('accountType') accountType?: string,
    @Query('planId')      planId?: string,
    @Query('isActive')    isActive?: string,
  ) {
    return this.svc.listTenants(scope, {
      page:   page  ? Number(page)  : undefined,
      limit:  limit ? Number(limit) : undefined,
      search,
      accountType,
      planId,
      isActive,
    });
  }

  @Get('tenants/:id')
  @ApiOperation({ summary: 'Get a tenant with full details (super admin)' })
  getTenant(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.getTenant(scope, id);
  }

  @Patch('tenants/:id')
  @ApiOperation({ summary: 'Update a tenant (super admin)' })
  updateTenant(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { isActive?: boolean; name?: string; categoryId?: string },
  ) {
    return this.svc.updateTenant(scope, id, body);
  }

  @Get('tenants/:id/contacts')
  @ApiOperation({ summary: 'List contacts for a tenant (super admin)' })
  getTenantContacts(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Query('page')   page?: string,
    @Query('limit')  limit?: string,
    @Query('search') search?: string,
  ) {
    return this.svc.adminGetTenantContacts(scope, id, {
      page:   page  ? Number(page)  : undefined,
      limit:  limit ? Number(limit) : undefined,
      search,
    });
  }

  @Post('tenants/:id/reset-password')
  @ApiOperation({ summary: 'Reset a user password (super admin)' })
  resetPassword(
    @CurrentTenant() scope: TenantScope,
    @Param('id') userId: string,
    @Body('newPassword') newPassword: string,
  ) {
    return this.svc.adminResetPassword(scope, userId, newPassword);
  }

  @Get('tenants/:id/wallet')
  @ApiOperation({ summary: 'Get wallet for a tenant (super admin)' })
  getTenantWallet(@CurrentTenant() scope: TenantScope, @Param('id') tenantId: string) {
    return this.svc.adminGetTenantWallet(scope, tenantId);
  }

  @Post('tenants/:id/wallet')
  @ApiOperation({ summary: 'Adjust wallet balance for a tenant (super admin)' })
  adjustWallet(
    @CurrentTenant() scope: TenantScope,
    @Param('id') tenantId: string,
    @Body('amount') amount: number,
    @Body('note') note: string,
  ) {
    return this.svc.adminAdjustWallet(scope, tenantId, amount, note);
  }

  @Post('tenants/:id/plan')
  @ApiOperation({ summary: 'Assign a plan to a tenant (super admin)' })
  assignPlan(
    @CurrentTenant() scope: TenantScope,
    @Param('id')           tenantId: string,
    @Body('planId')        planId: string,
    @Body('billingCycle')  billingCycle: string,
  ) {
    return this.svc.assignPlan(scope, tenantId, planId, billingCycle ?? 'MONTHLY');
  }

  @Get('audit-logs')
  @ApiOperation({ summary: 'List audit logs (super admin)' })
  listAuditLogs(
    @CurrentTenant() scope: TenantScope,
    @Query('tenantId') tenantId?: string,
    @Query('page')     page?: string,
    @Query('limit')    limit?: string,
    @Query('q')        q?: string,
  ) {
    return this.svc.listAuditLogs(scope, {
      tenantId,
      page:  page  ? Number(page)  : undefined,
      limit: limit ? Number(limit) : undefined,
      q,
    });
  }

  @Get('plans')
  @ApiOperation({ summary: 'List all plans (super admin)' })
  listPlans(@CurrentTenant() scope: TenantScope) {
    return this.svc.listPlans(scope);
  }

  @Post('plans')
  @ApiOperation({ summary: 'Create a plan (super admin)' })
  createPlan(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.createPlan(scope, body);
  }

  @Patch('plans/:id')
  @ApiOperation({ summary: 'Update a plan (super admin)' })
  updatePlan(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.svc.updatePlan(scope, id, body);
  }

  @Get('categories')
  @ApiOperation({ summary: 'List business categories (super admin)' })
  listCategories(@CurrentTenant() scope: TenantScope) {
    return this.svc.listCategories(scope);
  }

  @Post('categories')
  @ApiOperation({ summary: 'Create a business category (super admin)' })
  createCategory(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { name: string; isActive?: boolean; sortOrder?: number },
  ) {
    return this.svc.createCategory(scope, body);
  }

  @Patch('categories/:id')
  @ApiOperation({ summary: 'Update a business category (super admin)' })
  updateCategory(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { name?: string; isActive?: boolean; sortOrder?: number },
  ) {
    return this.svc.updateCategory(scope, id, body);
  }

  @Delete('categories/:id')
  @ApiOperation({ summary: 'Delete a business category (super admin)' })
  deleteCategory(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.deleteCategory(scope, id);
  }

  @Get('rates')
  @ApiOperation({ summary: 'List platform message rates (super admin)' })
  listRates(@CurrentTenant() scope: TenantScope) {
    return this.svc.listRates(scope);
  }

  @Put('rates')
  @ApiOperation({ summary: 'Upsert a message rate (super admin)' })
  updateRate(
    @CurrentTenant() scope: TenantScope,
    @Body('category')   category: string,
    @Body('resellerId') resellerId: string | undefined,
    @Body('priceMinor') priceMinor: number | null | undefined,
  ) {
    return this.svc.updateRate(scope, category, resellerId, priceMinor);
  }

  // ── View-as ─────────────────────────────────────────────────────────────────

  @Post('view-as')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start impersonating a client/reseller account (super admin)' })
  viewAs(@CurrentTenant() scope: TenantScope, @Body('tenantId') tenantId: string) {
    return this.svc.startViewAs(scope, tenantId);
  }

  @Delete('view-as')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop impersonating and return to admin panel (super admin)' })
  stopViewAs(@CurrentTenant() scope: TenantScope) {
    return this.svc.stopViewAs(scope);
  }

  // ── White-label ──────────────────────────────────────────────────────────────

  @Get('white-label')
  @ApiOperation({ summary: 'White-label resellers and fee config (super admin)' })
  getWhiteLabel(@CurrentTenant() scope: TenantScope) {
    return this.svc.getWhiteLabel(scope);
  }

  @Put('white-label')
  @ApiOperation({ summary: 'Update white-label fee settings (super admin)' })
  updateWhiteLabel(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { whiteLabelFeeMinor?: number; whiteLabelGraceDays?: number },
  ) {
    return this.svc.updateWhiteLabel(scope, body);
  }

  @Patch('white-label/:tenantId')
  @ApiOperation({ summary: 'Per-reseller white-label override (suspend, reactivate, fee override)' })
  patchTenantWhiteLabel(
    @CurrentTenant() scope: TenantScope,
    @Param('tenantId') tenantId: string,
    @Body() body: { action?: string; feeOverrideMinor?: number | null; reason?: string },
  ) {
    return this.svc.patchTenantWhiteLabel(scope, tenantId, body);
  }

  // ── CMS ──────────────────────────────────────────────────────────────────────

  @Get('cms/newsletter')
  @ApiOperation({ summary: 'Newsletter subscriber count and recent emails (super admin)' })
  cmsNewsletter(@CurrentTenant() scope: TenantScope) {
    return this.svc.getCmsNewsletter(scope);
  }

  @Get('cms/sections')
  @ApiOperation({ summary: 'List all CMS sections (super admin)' })
  cmsSections(@CurrentTenant() scope: TenantScope) {
    return this.svc.getCmsSections(scope);
  }

  @Get('cms/sections/:key')
  @ApiOperation({ summary: 'Get a CMS section (super admin)' })
  getCmsSection(@CurrentTenant() scope: TenantScope, @Param('key') key: string) {
    return this.svc.getCmsSection(scope, key);
  }

  @Put('cms/sections/:key')
  @ApiOperation({ summary: 'Save a CMS section (super admin)' })
  updateCmsSection(
    @CurrentTenant() scope: TenantScope,
    @Param('key') key: string,
    @Body() body: any,
  ) {
    return this.svc.updateCmsSection(scope, key, body);
  }

  @Delete('cms/sections/:key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset a CMS section to defaults (super admin)' })
  deleteCmsSection(@CurrentTenant() scope: TenantScope, @Param('key') key: string) {
    return this.svc.deleteCmsSection(scope, key);
  }

  // ── Commissions ──────────────────────────────────────────────────────────────

  @Get('commissions')
  @ApiOperation({ summary: 'List reseller commissions (super admin)' })
  listCommissions(
    @CurrentTenant() scope: TenantScope,
    @Query('status')     status?: string,
    @Query('resellerId') resellerId?: string,
    @Query('page')       page?: string,
    @Query('limit')      limit?: string,
  ) {
    return this.svc.listCommissions(scope, {
      status,
      resellerId,
      page:  page  ? Number(page)  : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ── Platform permissions matrix ───────────────────────────────────────────────

  @Get('permissions')
  @ApiOperation({ summary: 'Role/permission matrix (super admin)' })
  getPermissions(@CurrentTenant() scope: TenantScope) {
    return this.svc.getPermissionsMatrix(scope);
  }

  @Put('permissions')
  @ApiOperation({ summary: 'Set a role permission override (super admin)' })
  setPermission(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { accountType: string; role: string; permission: string; allowed: boolean | null },
  ) {
    return this.svc.setPermissionOverride(scope, body);
  }

  // ── Tenant Subscription ───────────────────────────────────────────────────────

  @Get('tenants/:id/subscription')
  @ApiOperation({ summary: 'Get subscription + plan + usage for a tenant (super admin)' })
  getTenantSubscription(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.getTenantSubscription(scope, id);
  }

  @Put('tenants/:id/subscription')
  @ApiOperation({ summary: 'Override plan/status for a tenant subscription (super admin)' })
  updateTenantSubscription(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { planId?: string; status?: string; currentPeriodEnd?: string },
  ) {
    return this.svc.updateTenantSubscription(scope, id, body);
  }

  // ── Tenant WhatsApp ───────────────────────────────────────────────────────────

  @Get('tenants/:id/whatsapp')
  @ApiOperation({ summary: 'List WhatsApp integrations for a tenant (super admin)' })
  getTenantWhatsApp(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.getTenantWhatsApp(scope, id);
  }

  @Post('tenants/:id/whatsapp')
  @ApiOperation({ summary: 'Admin WhatsApp action for a tenant (super admin)' })
  adminWhatsAppAction(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body('action') action: string,
  ) {
    return this.svc.adminWhatsAppAction(scope, id, action);
  }

  // ── Commissions (update) ──────────────────────────────────────────────────────

  @Patch('commissions/:id')
  @ApiOperation({ summary: 'Mark a commission paid or cancelled (super admin)' })
  updateCommission(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { status: string; note?: string },
  ) {
    return this.svc.updateCommission(scope, id, body);
  }

  // ── Plans (deactivate) ────────────────────────────────────────────────────────

  @Delete('plans/:id')
  @ApiOperation({ summary: 'Deactivate (soft-delete) a plan (super admin)' })
  deactivatePlan(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.deactivatePlan(scope, id);
  }

  // ── Health ────────────────────────────────────────────────────────────────────

  @Get('health')
  @ApiOperation({ summary: 'Admin service health check' })
  getHealth() {
    return this.svc.getHealth();
  }
}
