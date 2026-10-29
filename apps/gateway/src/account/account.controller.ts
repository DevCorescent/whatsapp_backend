import {
  Controller, Get, Put, Body, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { AccountService } from './account.service';

@ApiTags('account')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('account')
export class AccountController {
  constructor(private readonly svc: AccountService) {}

  @Get('category')
  @ApiOperation({ summary: "Get tenant's business category" })
  getCategory(@CurrentTenant() scope: TenantScope) {
    return this.svc.getCategory(scope);
  }

  @Put('category')
  @ApiOperation({ summary: "Set tenant's business category" })
  setCategory(
    @CurrentTenant() scope: TenantScope,
    @Body('categoryId') categoryId: string,
  ) {
    return this.svc.setCategory(scope, categoryId);
  }

  @Get('invite-code')
  @ApiOperation({ summary: "Get or generate the current user's invite code" })
  getInviteCode(@CurrentTenant() scope: TenantScope) {
    return this.svc.getInviteCode(scope);
  }

  @Get('audit-logs')
  @ApiOperation({ summary: "List this tenant's own audit log" })
  listAuditLogs(
    @CurrentTenant() scope: TenantScope,
    @Query('page')  page?: string,
    @Query('limit') limit?: string,
    @Query('q')     q?: string,
  ) {
    return this.svc.listAuditLogs(scope, {
      page:  page  ? parseInt(page,  10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      q,
    });
  }
}
