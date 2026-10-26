import {
  Controller, Get, Post, Patch, Delete, Put,
  Body, Param, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { SettingsService } from './settings.service';

@ApiTags('settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('settings')
export class SettingsController {
  constructor(private readonly svc: SettingsService) {}

  // ── Opt-out / Opt-in Manager ──────────────────────────────────────────────

  @Get('opt-out')
  @ApiOperation({ summary: 'Get opt-out / opt-in keyword config' })
  getOptOutConfig(@CurrentTenant() scope: TenantScope) {
    return this.svc.getOptOutConfig(scope);
  }

  @Put('opt-out')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update opt-out / opt-in keyword config' })
  updateOptOutConfig(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.updateOptOutConfig(scope, body);
  }

  // ── Combined settings endpoint (matches Next.js /api/settings) ────────────

  @Get()
  @ApiOperation({ summary: 'Get all settings for the current business' })
  getSettings(@CurrentTenant() scope: TenantScope) {
    return this.svc.getSettings(scope);
  }

  @Patch()
  @ApiOperation({ summary: 'Update settings for the current business' })
  updateSettings(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.updateSettings(scope, body);
  }

  // ── Message Rates ──────────────────────────────────────────────────────────

  @Get('message-rates')
  @ApiOperation({ summary: 'Get platform-level message rates per category' })
  getMessageRates(@CurrentTenant() scope: TenantScope) {
    return this.svc.getMessageRates(scope);
  }

  @Put('message-rates')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update platform-level message rates' })
  updateMessageRates(@CurrentTenant() scope: TenantScope, @Body('rates') rates: any[]) {
    return this.svc.updateMessageRates(scope, rates ?? []);
  }

  // ── Business / AI ──────────────────────────────────────────────────────────

  @Get('business')
  @ApiOperation({ summary: 'Get current business settings' })
  getBusiness(@CurrentTenant() scope: TenantScope) {
    return this.svc.getBusiness(scope);
  }

  @Get('ai')
  @ApiOperation({ summary: 'Get AI and auto-reply settings' })
  getAi(@CurrentTenant() scope: TenantScope) {
    return this.svc.getAiSettings(scope);
  }

  @Patch('ai')
  @ApiOperation({ summary: 'Update AI and auto-reply settings' })
  updateAi(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.updateAiSettings(scope, body);
  }

  // ── WhatsApp integrations ──────────────────────────────────────────────────

  @Get('integrations')
  @ApiOperation({ summary: 'List WhatsApp integrations' })
  listIntegrations(@CurrentTenant() scope: TenantScope) {
    return this.svc.listIntegrations(scope);
  }

  @Get('integrations/:id')
  @ApiOperation({ summary: 'Get a WhatsApp integration' })
  getIntegration(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.getIntegration(scope, id);
  }

  @Post('integrations')
  @ApiOperation({ summary: 'Create a WhatsApp integration' })
  createIntegration(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.createIntegration(scope, body);
  }

  @Patch('integrations/:id')
  @ApiOperation({ summary: 'Update a WhatsApp integration' })
  updateIntegration(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.svc.updateIntegration(scope, id, body);
  }

  @Delete('integrations/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a WhatsApp integration' })
  deleteIntegration(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.deleteIntegration(scope, id);
  }

  // ── WhatsApp connection flows ──────────────────────────────────────────────

  @Get('integrations/config')
  @ApiOperation({ summary: 'Get WhatsApp Embedded Signup public config (appId, configId)' })
  getWhatsAppConfig(@CurrentTenant() scope: TenantScope) {
    return this.svc.getWhatsAppConfig(scope);
  }

  @Post('integrations/connect')
  @ApiOperation({ summary: 'Connect via WhatsApp Embedded Signup (exchange OAuth code)' })
  connectEmbeddedSignup(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.connectEmbeddedSignup(scope, body);
  }

  @Post('integrations/manual')
  @ApiOperation({ summary: 'Connect via manual token entry' })
  connectManual(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.connectManual(scope, body);
  }

  @Post('integrations/:id/disconnect')
  @ApiOperation({ summary: 'Disconnect a WhatsApp integration (revoke token)' })
  disconnectIntegration(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.disconnectIntegration(scope, id);
  }

  @Post('integrations/:id/test')
  @ApiOperation({ summary: 'Test a WhatsApp integration by pinging Meta API' })
  testIntegration(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.testIntegration(scope, id);
  }

  @Get('whatsapp-health')
  @ApiOperation({ summary: 'Get quality rating and status for all active integrations' })
  getWhatsAppHealth(@CurrentTenant() scope: TenantScope) {
    return this.svc.getWhatsAppHealth(scope);
  }

  // ── Team ───────────────────────────────────────────────────────────────────

  @Get('team')
  @ApiOperation({ summary: 'List team members' })
  listTeam(@CurrentTenant() scope: TenantScope) {
    return this.svc.listTeam(scope);
  }

  @Post('team/invite')
  @ApiOperation({ summary: 'Invite a new team member' })
  invite(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.inviteTeamMember(scope, body);
  }

  @Patch('team/:id')
  @ApiOperation({ summary: 'Update a team member role or status' })
  updateMember(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.svc.updateTeamMember(scope, id, body);
  }

  @Delete('team/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a team member' })
  removeMember(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.removeTeamMember(scope, id);
  }
}
