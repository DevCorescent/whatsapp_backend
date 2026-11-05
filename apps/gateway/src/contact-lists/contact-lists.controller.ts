import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  JwtAuthGuard, CurrentTenant, TenantScope, PermissionGuard, RequiresPermission, requireFields,
} from '@lib/common';
import { ContactListsService } from './contact-lists.service';

@ApiTags('contact-lists')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequiresPermission('contacts.view')
@Controller('contact-lists')
export class ContactListsController {
  constructor(private readonly svc: ContactListsService) {}

  @Get()
  @ApiOperation({ summary: 'Contact lists for this department, with member counts' })
  list(@CurrentTenant() scope: TenantScope) {
    return this.svc.list(scope);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One contact list with its members' })
  get(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.get(scope, id);
  }

  @Post()
  @RequiresPermission('contacts.manage')
  @ApiOperation({ summary: 'Create a contact list' })
  create(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { name?: string; description?: string },
  ) {
    requireFields(body, ['name']);
    return this.svc.create(scope, { ...body, userId: scope.userId });
  }

  @Patch(':id')
  @RequiresPermission('contacts.manage')
  @ApiOperation({ summary: 'Rename a contact list or change its description' })
  update(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { name?: string; description?: string },
  ) {
    return this.svc.update(scope, id, body);
  }

  @Delete(':id')
  @RequiresPermission('contacts.manage')
  @ApiOperation({ summary: 'Delete a contact list (the contacts themselves are kept)' })
  remove(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.remove(scope, id);
  }

  @Post(':id/contacts')
  @RequiresPermission('contacts.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add contacts to a list' })
  addContacts(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { contactIds?: string[] },
  ) {
    requireFields(body, ['contactIds']);
    return this.svc.addContacts(scope, id, body.contactIds!);
  }

  @Delete(':id/contacts')
  @RequiresPermission('contacts.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove contacts from a list' })
  removeContacts(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { contactIds?: string[] },
  ) {
    requireFields(body, ['contactIds']);
    return this.svc.removeContacts(scope, id, body.contactIds!);
  }
}
