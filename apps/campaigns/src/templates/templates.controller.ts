import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { TemplatesService } from './templates.service';

@ApiTags('templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('templates')
export class TemplatesController {
  constructor(private readonly svc: TemplatesService) {}

  @Get()
  @ApiOperation({ summary: 'List message templates' })
  findAll(
    @CurrentTenant() scope: TenantScope,
    @Query('page')     page?: string,
    @Query('limit')    limit?: string,
    @Query('status')   status?: string,
    @Query('category') category?: string,
    @Query('search')   search?: string,
  ) {
    return this.svc.findAll(scope, {
      page:     page  ? Number(page)  : undefined,
      limit:    limit ? Number(limit) : undefined,
      status,
      category,
      search,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a template by ID' })
  findOne(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.findOne(scope, id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new message template' })
  create(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.create(scope, body);
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Import all templates from Meta into DB' })
  importFromMeta(@CurrentTenant() scope: TenantScope) {
    return this.svc.importFromMeta(scope);
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enqueue all PENDING templates (no waTemplateId) to sync queue' })
  syncAll(@CurrentTenant() scope: TenantScope) {
    return this.svc.syncAll(scope);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit template to Meta for approval' })
  submit(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.submitToMeta(scope, id);
  }

  @Post(':id/duplicate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Duplicate a template as a new PENDING copy' })
  duplicate(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.duplicate(scope, id);
  }

  @Post(':id/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh template status from Meta' })
  refreshStatus(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.refreshStatus(scope, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a template' })
  update(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.svc.update(scope, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a template' })
  remove(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.remove(scope, id);
  }

  @Post('upload-media')
  @HttpCode(HttpStatus.OK)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload template header sample media to Meta' })
  @UseInterceptors(FileInterceptor('file'))
  uploadMedia(
    @CurrentTenant() scope: TenantScope,
    @UploadedFile() file: any,
  ) {
    return this.svc.uploadHeaderMedia(scope, file);
  }
}
