import {
  Controller, Get, Post, Patch, Delete, Body, Param, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { BusinessesService } from './businesses.service';

@ApiTags('businesses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('businesses')
export class BusinessesController {
  constructor(private readonly svc: BusinessesService) {}

  @Get()
  @ApiOperation({ summary: 'List all businesses for the tenant' })
  list(@CurrentTenant() scope: TenantScope) {
    return this.svc.list(scope);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new business' })
  create(@CurrentTenant() scope: TenantScope, @Body('name') name: string) {
    return this.svc.create(scope, { name });
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a business' })
  update(
    @CurrentTenant() scope: TenantScope,
    @Param('id')       id: string,
    @Body()            body: { name?: string; logo?: string; timezone?: string; status?: string },
  ) {
    return this.svc.update(scope, id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a business (set status=INACTIVE)' })
  remove(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.remove(scope, id);
  }

  @Post('switch')
  @ApiOperation({ summary: 'Switch active business — returns business + JWT hint' })
  switchBusiness(
    @CurrentTenant() scope: TenantScope,
    @Body('businessId') businessId: string,
  ) {
    return this.svc.switchBusiness(scope, businessId);
  }
}
