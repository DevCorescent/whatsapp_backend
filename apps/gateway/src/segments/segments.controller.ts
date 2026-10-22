import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { SegmentsService } from './segments.service';

@ApiTags('segments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('segments')
export class SegmentsController {
  constructor(private readonly svc: SegmentsService) {}

  @Get()
  @ApiOperation({ summary: 'List segments for tenant + business' })
  list(
    @CurrentTenant() scope: TenantScope,
    @Query('page')   page?: string,
    @Query('limit')  limit?: string,
    @Query('search') search?: string,
  ) {
    return this.svc.list(scope, {
      page:   page  ? Number(page)  : undefined,
      limit:  limit ? Number(limit) : undefined,
      search,
    });
  }

  @Get('options')
  @ApiOperation({ summary: 'Available filter field definitions' })
  options(@CurrentTenant() scope: TenantScope) {
    return this.svc.options(scope);
  }

  @Post('preview')
  @ApiOperation({ summary: 'Preview contacts matching given filters' })
  preview(@CurrentTenant() scope: TenantScope, @Body() body: { filters: unknown }) {
    return this.svc.preview(scope, body.filters);
  }

  @Post()
  @ApiOperation({ summary: 'Create a segment' })
  create(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { name: string; description?: string; filters: unknown },
  ) {
    return this.svc.create(scope, body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a segment' })
  update(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { name?: string; description?: string; filters?: unknown },
  ) {
    return this.svc.update(scope, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a segment' })
  remove(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.remove(scope, id);
  }
}
