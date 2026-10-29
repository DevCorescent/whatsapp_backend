import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards,
  HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { ContactsService } from './contacts.service';

@ApiTags('contacts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('contacts')
export class ContactsController {
  constructor(private readonly svc: ContactsService) {}

  @Get()
  @ApiOperation({ summary: 'List contacts with pagination and filters' })
  findAll(
    @CurrentTenant() scope: TenantScope,
    @Query('page')     page?: string,
    @Query('limit')    limit?: string,
    @Query('search')   search?: string,
    @Query('source')   source?: string,
    @Query('tag')      tag?: string,
    @Query('optedOut') optedOut?: string,
  ) {
    return this.svc.findAll(scope, {
      page:     page    ? Number(page)    : undefined,
      limit:    limit   ? Number(limit)   : undefined,
      search,
      source,
      tag,
      optedOut: optedOut != null ? optedOut === 'true' : undefined,
    });
  }

  @Get('sources')
  @ApiOperation({ summary: 'Get all contact source labels' })
  getSources(@CurrentTenant() scope: TenantScope) {
    return this.svc.getSources(scope);
  }

  @Get('tags')
  @ApiOperation({ summary: 'Get all tags for this business' })
  getTags(@CurrentTenant() scope: TenantScope) {
    return this.svc.listTags(scope);
  }

  @Get('imports')
  @ApiOperation({ summary: 'Recent spreadsheet import runs for this business' })
  listImports(@CurrentTenant() scope: TenantScope, @Query('limit') limit?: string) {
    return this.svc.listImports(scope, limit ? Number(limit) : undefined);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single contact' })
  findOne(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.findOne(scope, id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a contact' })
  create(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.create(scope, body);
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk action on contacts (create/delete/block/unblock/addTag/removeTag)' })
  bulk(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.bulkAction(scope, body.action ?? 'create', body.ids, body.contacts, body.tagId);
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Import contacts from parsed CSV rows with optional tags' })
  import(
    @CurrentTenant() scope: TenantScope,
    @Body() body: any,
  ) {
    // Support both legacy { rows, importTags } and new { contacts, mode, dryRun } shapes
    const contacts: any[] = body.contacts ?? body.rows ?? [];
    const importTags: string[] = body.importTags ?? [];
    const dryRun: boolean = body.dryRun === true;
    return this.svc.importContactsV2(scope, contacts, importTags, dryRun, {
      mode:      body.mode,
      importId:  typeof body.importId  === 'string' ? body.importId.slice(0, 64)   : undefined,
      fileName:  typeof body.fileName  === 'string' ? body.fileName.slice(0, 255)  : undefined,
      sheetName: typeof body.sheetName === 'string' ? body.sheetName.slice(0, 255) : undefined,
    });
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a contact' })
  update(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.svc.update(scope, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a contact' })
  remove(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.remove(scope, id);
  }
}
