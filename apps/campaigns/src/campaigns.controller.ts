import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards,
  HttpCode, HttpStatus, UseInterceptors, UploadedFile,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope, PermissionGuard, RequiresPermission, requireFields,} from '@lib/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CampaignsService } from './campaigns.service';

@ApiTags('campaigns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequiresPermission('campaigns.view')
@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly svc: CampaignsService) {}

  @Get()
  @ApiOperation({ summary: 'List campaigns' })
  findAll(
    @CurrentTenant() scope: TenantScope,
    @Query('page')   page?: string,
    @Query('limit')  limit?: string,
    @Query('status') status?: string,
  ) {
    return this.svc.findAll(scope, {
      page:   page  ? Number(page)  : undefined,
      limit:  limit ? Number(limit) : undefined,
      status,
    });
  }

  @Get('tier-allowance')
  @ApiOperation({ summary: "What is left of this number's 24-hour sending allowance" })
  tierAllowance(
    @CurrentTenant() scope: TenantScope,
    @Query('whatsappIntegrationId') whatsappIntegrationId?: string,
  ) {
    return this.svc.tierAllowance(scope, whatsappIntegrationId);
  }

  @Get('scheduled')
  @ApiOperation({ summary: 'List upcoming scheduled campaigns' })
  listScheduled(@CurrentTenant() scope: TenantScope) {
    return this.svc.listScheduled(scope);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a campaign by ID with full recipient list' })
  findOne(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.getDetail(scope, id);
  }

  @Get(':id/stats')
  @ApiOperation({ summary: 'Get delivery stats for a campaign' })
  stats(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.getStats(scope, id);
  }

  @Post()
  @RequiresPermission('campaigns.send')
  @ApiOperation({ summary: 'Create a campaign' })
  create(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.create(scope, body);
  }

  @Post(':id/contacts')
  @RequiresPermission('campaigns.send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add recipients to a campaign' })
  addContacts(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body('contacts') contacts: any[]) {
    return this.svc.addContacts(scope, id, contacts ?? []);
  }

  @Post(':id/contacts-from-lists')
  @RequiresPermission('campaigns.send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Fill campaign recipients from hand-picked contact lists' })
  addContactsFromLists(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { listIds?: string[] },
  ) {
    requireFields(body, ['listIds']);
    return this.svc.addContactsFromLists(scope, id, body.listIds!);
  }

  @Post(':id/duplicate')
  @RequiresPermission('campaigns.send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Duplicate a campaign as a new DRAFT' })
  duplicate(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.duplicate(scope, id);
  }

  @Post(':id/launch')
  @RequiresPermission('campaigns.send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Launch a campaign (enqueue all pending recipients)' })
  launch(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.launch(scope, id);
  }

  @Post(':id/cancel')
  @RequiresPermission('campaigns.send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a running or scheduled campaign' })
  cancel(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.cancel(scope, id);
  }

  @Post(':id/pause')
  @RequiresPermission('campaigns.send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pause a running campaign, keeping its pending recipients' })
  pause(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: { reason?: string } = {}) {
    return this.svc.pause(scope, id, body?.reason);
  }

  @Post(':id/resume')
  @RequiresPermission('campaigns.send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume a paused campaign from where it stopped' })
  resume(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.resume(scope, id);
  }

  @Get(':id/failures')
  @ApiOperation({ summary: 'Why recipients failed, grouped by WhatsApp error code' })
  failures(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.getFailureBreakdown(scope, id);
  }

  @Patch(':id')
  @RequiresPermission('campaigns.send')
  @ApiOperation({ summary: 'Update a campaign (DRAFT/SCHEDULED only)' })
  update(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.svc.update(scope, id, body);
  }

  @Delete(':id')
  @RequiresPermission('campaigns.send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a campaign (DRAFT/SCHEDULED/CANCELLED only)' })
  remove(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.remove(scope, id);
  }

  @Post('upload-media')
  @RequiresPermission('campaigns.send')
  @HttpCode(HttpStatus.OK)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload campaign media to Meta and return media ID' })
  @UseInterceptors(FileInterceptor('file'))
  uploadMedia(
    @CurrentTenant() scope: TenantScope,
    @UploadedFile() file: any,
    // Names the WhatsApp number to upload against: a media id only works for the number
    // it was uploaded to, and the template decides which number sends.
    @Body('templateId') templateId?: string,
  ) {
    return this.svc.uploadCampaignMedia(scope, file, templateId);
  }
}
