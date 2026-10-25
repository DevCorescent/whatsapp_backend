import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { TagsService } from './tags.service';

@ApiTags('tags')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('tags')
export class TagsController {
  constructor(private readonly svc: TagsService) {}

  @Get()
  findAll(@CurrentTenant() scope: TenantScope) {
    return this.svc.findAll(scope);
  }

  @Post()
  create(@CurrentTenant() scope: TenantScope, @Body() body: { name: string; color: string }) {
    return this.svc.create(scope, body);
  }

  @Patch(':id')
  update(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: { name?: string; color?: string }) {
    return this.svc.update(scope, id, body);
  }

  @Delete(':id')
  remove(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.remove(scope, id);
  }
}
