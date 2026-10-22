import {
  Controller, Get, Post, Patch, Delete, Put,
  Body, Param, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { SettingsService } from '../settings/settings.service';

/**
 * URL alias for /settings/team* — the Next.js API routes live at /api/team
 * but NestJS put them under /settings/team. This controller re-exposes them
 * at /team so the proxy needs no special-case rewriting.
 */
@ApiTags('team')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('team')
export class TeamController {
  constructor(private readonly svc: SettingsService) {}

  @Get()
  list(@CurrentTenant() scope: TenantScope) {
    return this.svc.listTeam(scope);
  }

  @Post()
  invite(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.inviteTeamMember(scope, body);
  }

  @Patch(':id')
  update(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.svc.updateTeamMember(scope, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.removeTeamMember(scope, id);
  }

  @Get(':id/permissions')
  getPermissions(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.getTeamPermissions(scope, id);
  }

  @Put(':id/permissions')
  updatePermissions(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body('overrides') overrides: Record<string, boolean | null>,
  ) {
    return this.svc.updateTeamPermissions(scope, id, overrides ?? {});
  }
}
