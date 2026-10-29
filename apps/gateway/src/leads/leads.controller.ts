import {
  Controller, Get, Post, Patch, Put, Delete, Res,
  Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope, PermissionGuard, RequiresPermission } from '@lib/common';
import { LeadsService } from './leads.service';

@ApiTags('leads')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequiresPermission('contacts.view')
@Controller()
export class LeadsController {
  constructor(private readonly svc: LeadsService) {}

  // ── Pipeline Stages ─────────────────────────────────────────────────────────

  @Get('lead-stages')
  @ApiOperation({ summary: 'List pipeline stages' })
  listStages(@CurrentTenant() scope: TenantScope) {
    return this.svc.listStages(scope);
  }

  @Patch('lead-stages')
  @RequiresPermission('settings.manage')
  @ApiOperation({ summary: 'Bulk upsert pipeline stages' })
  bulkUpdateStages(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.bulkUpdateStages(scope, body);
  }

  // ── Leads ──────────────────────────────────────────────────────────────────

  @Get('leads')
  @ApiOperation({ summary: 'List leads, narrowed by any of the filters' })
  listLeads(@CurrentTenant() scope: TenantScope, @Query() query: Record<string, string>) {
    return this.svc.listLeads(scope, {
      ...query,
      // "me" saves the client needing to know its own id.
      assignedToId: query.assignedToId === 'me' ? scope.userId : query.assignedToId,
      page:  query.page  ? Number(query.page)  : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
    });
  }

  @Get('leads/filters')
  @ApiOperation({ summary: 'The filters and export columns a lead list offers' })
  filterOptions(@CurrentTenant() scope: TenantScope) {
    return this.svc.filterOptions(scope);
  }

  @Get('leads/export')
  @RequiresPermission('contacts.export')
  @ApiOperation({ summary: 'Download the filtered leads as CSV' })
  async exportLeads(
    @CurrentTenant() scope: TenantScope,
    @Query() query: Record<string, string>,
    @Res() res: Response,
  ) {
    const { csv, count } = await this.svc.exportLeads(scope, {
      ...query,
      assignedToId: query.assignedToId === 'me' ? scope.userId : query.assignedToId,
      limit: query.limit ? Number(query.limit) : undefined,
    });
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.header('X-Row-Count', String(count));
    // A BOM so Excel reads the UTF-8 in names and currencies rather than mangling it.
    res.send(`﻿${csv}`);
  }

  // ── AI qualification ───────────────────────────────────────────────────────

  @Get('leads/qualification')
  @ApiOperation({ summary: 'How the model is set to judge conversations' })
  qualificationConfig(@CurrentTenant() scope: TenantScope) {
    return this.svc.getQualificationConfig(scope);
  }

  @Put('leads/qualification')
  @RequiresPermission('settings.manage')
  @ApiOperation({ summary: 'Set how the model judges conversations' })
  saveQualification(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.saveQualificationConfig(scope, body);
  }

  @Post('leads/qualify')
  @RequiresPermission('contacts.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Score one conversation now and open or update its lead' })
  qualify(@CurrentTenant() scope: TenantScope, @Body() body: { conversationId?: string }) {
    return this.svc.qualifyConversation(scope, String(body?.conversationId ?? ''));
  }

  @Post('leads/import')
  @RequiresPermission('contacts.import')
  @ApiOperation({ summary: 'Bulk import leads' })
  importLeads(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.importLeads(scope, body);
  }

  @Post('leads')
  @RequiresPermission('contacts.manage')
  @ApiOperation({ summary: 'Create a lead' })
  createLead(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.createLead(scope, body);
  }

  @Get('leads/:id')
  @ApiOperation({ summary: 'Get a lead' })
  getLead(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.getLead(scope, id);
  }

  @Patch('leads/:id')
  @RequiresPermission('contacts.manage')
  @ApiOperation({ summary: 'Update a lead' })
  updateLead(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.svc.updateLead(scope, id, body);
  }

  @Delete('leads/:id')
  @RequiresPermission('contacts.delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a lead' })
  deleteLead(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.deleteLead(scope, id);
  }

  @Post('leads/:id/activities')
  @RequiresPermission('contacts.manage')
  @ApiOperation({ summary: 'Add activity to a lead' })
  addActivity(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.svc.addActivity(scope, id, body);
  }
}
