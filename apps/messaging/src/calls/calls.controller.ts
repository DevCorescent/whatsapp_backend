import {
  Controller, Get, Post, Put, Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, PlanFeatureGuard, RequiresPlanFeature, CurrentTenant, TenantScope, PermissionGuard, RequiresPermission } from '@lib/common';
import { CallsService } from './calls.service';

@ApiTags('calls')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlanFeatureGuard, PermissionGuard)
@RequiresPlanFeature('callingEnabled')
@RequiresPermission('conversations.view')
@Controller('calls')
export class CallsController {
  constructor(private readonly svc: CallsService) {}

  @Get('ice-servers')
  @ApiOperation({ summary: 'ICE servers for the browser RTCPeerConnection' })
  iceServers() {
    return { iceServers: this.svc.iceServers() };
  }

  @Get()
  @ApiOperation({ summary: 'Call history for this business' })
  list(
    @CurrentTenant() scope: TenantScope,
    @Query('page')           page?: string,
    @Query('limit')          limit?: string,
    @Query('status')         status?: string,
    @Query('contactId')      contactId?: string,
    @Query('conversationId') conversationId?: string,
  ) {
    return this.svc.list(scope, {
      page:  page  ? Number(page)  : undefined,
      limit: limit ? Number(limit) : undefined,
      status, contactId, conversationId,
    });
  }

  @Get('settings/:integrationId')
  @ApiOperation({ summary: 'Calling setting for a WhatsApp number (read from Meta)' })
  getSettings(@CurrentTenant() scope: TenantScope, @Param('integrationId') integrationId: string) {
    return this.svc.getCallingSettings(scope, integrationId);
  }

  @Put('settings/:integrationId')
  @RequiresPermission('settings.manage')
  @ApiOperation({ summary: 'Enable or disable calling on a WhatsApp number' })
  setSettings(
    @CurrentTenant() scope: TenantScope,
    @Param('integrationId') integrationId: string,
    @Body() body: { enabled?: boolean },
  ) {
    return this.svc.setCallingEnabled(scope, integrationId, body?.enabled === true);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One call' })
  get(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.get(scope, id);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Answer a ringing call with the browser SDP answer' })
  accept(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: { sdp?: string }) {
    return this.svc.accept(scope, id, body?.sdp ?? '');
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline a ringing call' })
  reject(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.reject(scope, id);
  }

  @Post(':id/hangup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End a connected call' })
  hangup(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.hangup(scope, id);
  }
}
