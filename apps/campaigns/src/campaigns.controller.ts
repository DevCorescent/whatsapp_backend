import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards,
  HttpCode, HttpStatus, UseInterceptors, UploadedFile,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CampaignsService } from './campaigns.service';

@ApiTags('campaigns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
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
  @ApiOperation({ summary: 'Create a campaign' })
  create(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.create(scope, body);
  }

  @Post(':id/contacts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add recipients to a campaign' })
  addContacts(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body('contacts') contacts: any[]) {
    return this.svc.addContacts(scope, id, contacts ?? []);
  }

  @Post(':id/duplicate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Duplicate a campaign as a new DRAFT' })
  duplicate(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.duplicate(scope, id);
  }

  @Post(':id/launch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Launch a campaign (enqueue all pending recipients)' })
  launch(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.launch(scope, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a running or scheduled campaign' })
  cancel(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.cancel(scope, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a campaign (DRAFT/SCHEDULED only)' })
  update(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.svc.update(scope, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a campaign (DRAFT/SCHEDULED/CANCELLED only)' })
  remove(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.remove(scope, id);
  }

  @Post('upload-media')
  @HttpCode(HttpStatus.OK)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload campaign media to Meta and return media ID' })
  @UseInterceptors(FileInterceptor('file'))
  uploadMedia(
    @CurrentTenant() scope: TenantScope,
    @UploadedFile() file: any,
  ) {
    return this.svc.uploadCampaignMedia(scope, file);
  }
}
