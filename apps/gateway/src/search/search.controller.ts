import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope, PermissionGuard, RequiresPermission } from '@lib/common';
import { SearchService } from './search.service';

@ApiTags('search')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequiresPermission('contacts.view')
@Controller('search')
export class SearchController {
  constructor(private readonly svc: SearchService) {}

  @Get()
  @ApiOperation({ summary: 'Search across contacts, conversations, campaigns, and leads' })
  search(
    @CurrentTenant() scope: TenantScope,
    @Query('q')    q: string,
    @Query('type') type?: string,
  ) {
    return this.svc.search(scope, q ?? '', (type as any) ?? 'all');
  }
}
