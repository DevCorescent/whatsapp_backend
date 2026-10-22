import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { TicketsService } from './tickets.service';

@ApiTags('tickets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('tickets')
export class TicketsController {
  constructor(private readonly svc: TicketsService) {}

  @Get()
  @ApiOperation({ summary: 'List tickets' })
  list(
    @CurrentTenant() scope: TenantScope,
    @Query('page')         page?:         string,
    @Query('limit')        limit?:        string,
    @Query('status')       status?:       string,
    @Query('priority')     priority?:     string,
    @Query('assignedToId') assignedToId?: string,
  ) {
    return this.svc.list(scope, {
      page:         page  ? Number(page)  : undefined,
      limit:        limit ? Number(limit) : undefined,
      status,
      priority,
      assignedToId,
    });
  }

  @Post()
  @ApiOperation({ summary: 'Create a ticket' })
  create(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.create(scope, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a ticket' })
  get(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.get(scope, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a ticket' })
  update(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.svc.update(scope, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a ticket' })
  remove(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.remove(scope, id);
  }
}
