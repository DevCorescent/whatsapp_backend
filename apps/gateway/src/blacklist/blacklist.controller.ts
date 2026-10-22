import {
  Controller, Get, Post, Delete,
  Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { BlacklistService } from './blacklist.service';

@ApiTags('blacklist')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('blacklist')
export class BlacklistController {
  constructor(private readonly svc: BlacklistService) {}

  @Get()
  @ApiOperation({ summary: 'List blacklist entries for tenant (and platform-wide)' })
  list(
    @CurrentTenant() scope: TenantScope,
    @Query('page')   page?: string,
    @Query('limit')  limit?: string,
    @Query('search') search?: string,
  ) {
    return this.svc.list(scope, {
      page:   page   ? Number(page)  : undefined,
      limit:  limit  ? Number(limit) : undefined,
      search: search ?? '',
    });
  }

  @Get('history')
  @ApiOperation({ summary: 'Blacklist action history from audit log' })
  history(
    @CurrentTenant() scope: TenantScope,
    @Query('phone') phone?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.history(scope, {
      phone: phone,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post()
  @ApiOperation({ summary: 'Bulk-add phones to the blacklist' })
  create(@CurrentTenant() scope: TenantScope, @Body() body: { phones: string[]; reason?: string; scope?: string }) {
    return this.svc.create(scope, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a tenant blacklist entry' })
  remove(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.remove(scope, id);
  }
}
