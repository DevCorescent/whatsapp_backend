import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, HttpCode, HttpStatus, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope, PermissionGuard, RequiresPermission } from '@lib/common';
import { SettingsService } from '../settings/settings.service';

/**
 * Exposes WhatsApp integration endpoints at /integrations/whatsapp
 * to match the URL structure the Next.js frontend expects.
 * Logic lives in SettingsService (same as /settings/integrations*).
 */
@ApiTags('integrations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequiresPermission('settings.manage')
@Controller('integrations')
export class IntegrationsController {
  private readonly logger = new Logger(IntegrationsController.name);

  constructor(private readonly svc: SettingsService) {}

  // ── WhatsApp integrations ────────────────────────────────────────────────────

  /**
   * Which numbers this workspace has connected.
   *
   * Managing an integration is a settings job, but *knowing which numbers exist* is not:
   * the inbox filters by number, a template belongs to one, and a campaign sends from
   * one — so an agent who can see conversations needs this list. The response has
   * already had its tokens and secrets stripped. Without this the dashboard asked for it
   * on every page load and every role below admin got a 403 in the console.
   */
  @RequiresPermission('conversations.view')
  @Get('whatsapp')
  listWhatsApp(
    @CurrentTenant() scope: TenantScope,
    @Query('businessId') businessId?: string,
  ) {
    return this.svc.listIntegrations(scope, businessId);
  }

  @Get('whatsapp/config')
  getWhatsAppConfig(@CurrentTenant() scope: TenantScope) {
    return this.svc.getWhatsAppConfig(scope);
  }

  @Post('whatsapp/connect')
  connectEmbeddedSignup(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.connectEmbeddedSignup(scope, body);
  }

  @Post('whatsapp/manual')
  connectManual(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.connectManual(scope, body);
  }

  @Patch('whatsapp/:id')
  updateIntegration(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.svc.updateIntegration(scope, id, body);
  }

  @Post('whatsapp/:id/disconnect')
  @HttpCode(HttpStatus.OK)
  disconnectIntegration(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.disconnectIntegration(scope, id);
  }

  /** Called by the new direct-proxy route with id in the URL */
  @Post('whatsapp/:id/test')
  @HttpCode(HttpStatus.OK)
  testIntegrationById(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    this.logger.log(`POST /integrations/whatsapp/${id}/test — tenantId=${scope.tenantId} businessId=${scope.businessId}`);
    return this.svc.testIntegration(scope, id);
  }

  /** Called by the generic nest-proxy route with integrationId in the body */
  @Post('whatsapp/test')
  @HttpCode(HttpStatus.OK)
  testIntegrationByBody(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { integrationId: string },
  ) {
    this.logger.log(`POST /integrations/whatsapp/test (body) — id=${body.integrationId} tenantId=${scope.tenantId} businessId=${scope.businessId}`);
    return this.svc.testIntegration(scope, body.integrationId);
  }

  @Delete('whatsapp/:id')
  @HttpCode(HttpStatus.OK)
  deleteIntegration(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.deleteIntegration(scope, id);
  }
}
