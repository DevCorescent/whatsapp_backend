import {
  Controller, Get, Post, Patch, Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope, PermissionGuard, RequiresPermission } from '@lib/common';
import { ConversationsService } from './conversations.service';

@ApiTags('conversations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequiresPermission('conversations.view')
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly svc: ConversationsService) {}

  @Get()
  @ApiOperation({ summary: 'List conversations with filters' })
  findAll(
    @CurrentTenant() scope: TenantScope,
    @Query('page')         page?: string,
    @Query('limit')        limit?: string,
    @Query('status')       status?: string,
    @Query('search')       search?: string,
    @Query('assignedToId') assignedToId?: string,
    @Query('isAiActive')   isAiActive?: string,
    @Query('whatsappIntegrationId') whatsappIntegrationId?: string,
  ) {
    return this.svc.findAll(scope, {
      page:         page  ? Number(page)  : undefined,
      limit:        limit ? Number(limit) : undefined,
      status,
      search,
      assignedToId,
      isAiActive:   isAiActive != null ? isAiActive === 'true' : undefined,
      whatsappIntegrationId,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a conversation by ID' })
  findOne(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Query('page') page?: string,
  ) {
    return this.svc.findOne(scope, id, { page: Number(page) || 1 });
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Get messages in a conversation' })
  getMessages(
    @CurrentTenant() scope: TenantScope,
    @Param('id')    id: string,
    @Query('page')  page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.getMessages(scope, id, {
      page:  page  ? Number(page)  : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update conversation status, assignment or AI toggle' })
  update(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.svc.update(scope, id, body);
  }

  @Post(':id/messages')
  @RequiresPermission('messages.send')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Send an outbound message (or internal note)' })
  sendMessage(
    @CurrentTenant() scope: TenantScope,
    @Param('id')    id: string,
    @Body()         body: any,
  ) {
    return this.svc.sendMessage(scope, id, body);
  }
}
