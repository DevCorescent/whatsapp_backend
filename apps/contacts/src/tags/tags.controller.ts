import {
  Controller, Get, Post, Body, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { ContactsService } from '../contacts.service';

@ApiTags('tags')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('contacts/tags')
export class TagsController {
  constructor(private readonly svc: ContactsService) {}

  @Get()
  @ApiOperation({ summary: 'List all tags for this business' })
  list(@CurrentTenant() scope: TenantScope) {
    return this.svc.listTags(scope);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new tag' })
  create(
    @CurrentTenant() scope: TenantScope,
    @Body('name')  name: string,
    @Body('color') color?: string,
  ) {
    return this.svc.createTag(scope, name, color);
  }
}
