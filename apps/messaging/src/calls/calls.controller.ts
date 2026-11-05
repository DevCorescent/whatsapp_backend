import {
  Controller, Get, Post, Put, Body, Param, Query, UseGuards, HttpCode, HttpStatus, UseInterceptors, UploadedFile, Logger,} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard, PlanFeatureGuard, RequiresPlanFeature, CurrentTenant, TenantScope, PermissionGuard, RequiresPermission, requireFields,} from '@lib/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CallsService } from './calls.service';

@ApiTags('calls')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlanFeatureGuard, PermissionGuard)
@RequiresPlanFeature('callingEnabled')
@RequiresPermission('conversations.view')
@Controller('calls')
export class CallsController {
  private readonly logger = new Logger(CallsController.name);

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

  @Get('recordings')
  @ApiOperation({ summary: 'Call recordings for this department, newest first' })
  listRecordings(
    @CurrentTenant() scope: TenantScope,
    @Query('page')  page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.listRecordings(scope, {
      page:  page  ? Number(page)  : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('recordings/:id/url')
  @ApiOperation({ summary: 'A short-lived link to a recording' })
  recordingUrl(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.recordingUrl(scope, id);
  }

  @Post(':id/recording')
  @HttpCode(HttpStatus.OK)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload the audio captured for a call' })
  @UseInterceptors(FileInterceptor('file'))
  saveRecording(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @UploadedFile() file: any,
    @Body() body: { durationSec?: string },
  ) {
    // Logged at the edge as well as in the service: if multer never populated `file`,
    // the difference between "nothing was sent" and "the interceptor rejected it" shows
    // up here, before any of our own checks have run.
    this.logger.log(
      `[recording] POST /calls/${id}/recording reached the controller · ` +
      `file=${file ? 'present' : 'MISSING'} bodyKeys=${Object.keys(body ?? {}).join(',') || 'none'}`,
    );
    return this.svc.saveRecording(
      scope, id, file, body?.durationSec ? Number(body.durationSec) : undefined,
    );
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
    @Body() body: { enabled?: boolean; followBusinessHours?: boolean },
  ) {
    return this.svc.setCallingEnabled(
      scope, integrationId, body?.enabled === true, body?.followBusinessHours,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'One call' })
  get(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.get(scope, id);
  }

  @Post()
  @RequiresPermission('conversations.view')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Place a call to a contact (business-initiated)' })
  initiate(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { contactId?: string; sdpOffer?: string; integrationId?: string },
  ) {
    requireFields(body, ['contactId', 'sdpOffer']);
    return this.svc.initiate(scope, body as { contactId: string; sdpOffer: string; integrationId?: string });
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
