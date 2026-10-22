import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { LeadsService } from './leads.service';

@ApiTags('leads')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
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
  @ApiOperation({ summary: 'Bulk upsert pipeline stages' })
  bulkUpdateStages(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.bulkUpdateStages(scope, body);
  }

  // ── Leads ──────────────────────────────────────────────────────────────────

  @Get('leads')
  @ApiOperation({ summary: 'List leads' })
  listLeads(
    @CurrentTenant()         scope: TenantScope,
    @Query('page')           page?: string,
    @Query('limit')          limit?: string,
    @Query('search')         search?: string,
    @Query('stageId')        stageId?: string,
    @Query('assignedToId')   assignedToId?: string,
    @Query('scoreLabel')     scoreLabel?: string,
  ) {
    return this.svc.listLeads(scope, {
      page:         page  ? Number(page)  : undefined,
      limit:        limit ? Number(limit) : undefined,
      search,
      stageId,
      assignedToId,
      scoreLabel,
    });
  }

  @Post('leads/import')
  @ApiOperation({ summary: 'Bulk import leads' })
  importLeads(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.importLeads(scope, body);
  }

  @Post('leads')
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
  @ApiOperation({ summary: 'Update a lead' })
  updateLead(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.svc.updateLead(scope, id, body);
  }

  @Delete('leads/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a lead' })
  deleteLead(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.deleteLead(scope, id);
  }

  @Post('leads/:id/activities')
  @ApiOperation({ summary: 'Add activity to a lead' })
  addActivity(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.svc.addActivity(scope, id, body);
  }
}
