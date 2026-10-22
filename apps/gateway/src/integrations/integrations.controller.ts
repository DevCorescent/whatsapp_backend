import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { SettingsService } from '../settings/settings.service';

/**
 * Exposes WhatsApp integration endpoints at /integrations/whatsapp
 * to match the URL structure the Next.js frontend expects.
 * Logic lives in SettingsService (same as /settings/integrations*).
 */
@ApiTags('integrations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly svc: SettingsService) {}

  // ── WhatsApp integrations ────────────────────────────────────────────────────

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

  @Post('whatsapp/:id/test')
  @HttpCode(HttpStatus.OK)
  testIntegration(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.testIntegration(scope, id);
  }

  @Delete('whatsapp/:id')
  @HttpCode(HttpStatus.OK)
  deleteIntegration(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.deleteIntegration(scope, id);
  }
}
