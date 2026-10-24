import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { ChatbotService } from './chatbot.service';
import { KnowledgeService } from '../knowledge/knowledge.service';

/**
 * Chatbot controller.
 *
 * /chatbot/respond   — existing chatbot response endpoint
 * /chatbot/flows/*   — URL alias for /knowledge/flows/* (Next.js uses this path)
 */
@ApiTags('chatbot')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('chatbot')
export class ChatbotController {
  constructor(
    private readonly svc:       ChatbotService,
    private readonly knowledge: KnowledgeService,
  ) {}

  @Post('respond')
  @ApiOperation({ summary: 'Get chatbot response for a conversation message' })
  respond(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { conversationId: string; message: string },
  ) {
    return this.svc.respondChatbot(scope, body);
  }

  // ── /chatbot/flows/* — alias for /knowledge/flows/* ───────────────────────

  @Get('flows')
  @ApiOperation({ summary: 'List chatbot flows' })
  listFlows(
    @CurrentTenant() scope: TenantScope,
    @Query('active') active?: string,
  ) {
    return this.knowledge.listFlows(scope, active !== undefined ? { active: active === 'true' } : {});
  }

  @Post('flows')
  @ApiOperation({ summary: 'Create a chatbot flow' })
  createFlow(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.knowledge.createFlow(scope, body);
  }

  @Post('flows/:id/duplicate')
  duplicateFlow(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.knowledge.duplicateFlow(scope, id);
  }

  @Post('flows/:id/publish')
  publishFlow(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.knowledge.publishFlow(scope, id);
  }

  @Post('flows/:id/draft')
  draftFlow(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.knowledge.draftFlow(scope, id);
  }

  @Post('flows/:id/preview')
  previewFlow(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { message?: string; nodes?: unknown[]; edges?: unknown[]; fromNodeId?: string; variables?: Record<string, string> },
  ) {
    return this.knowledge.previewFlow(scope, id, body);
  }

  @Post('flows/:id/validate')
  validateFlow(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { nodes?: unknown[]; edges?: unknown[] },
  ) {
    return this.knowledge.validateFlow(scope, id, body?.nodes, body?.edges);
  }

  @Post('flows/:id/autosave')
  autosaveFlow(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { nodes: any; edges: any },
  ) {
    return this.knowledge.autosaveFlow(scope, id, body.nodes, body.edges);
  }

  @Get('flows/:id')
  getFlow(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.knowledge.getFlow(scope, id);
  }

  @Patch('flows/:id')
  updateFlow(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.knowledge.updateFlow(scope, id, body);
  }

  @Delete('flows/:id')
  @HttpCode(HttpStatus.OK)
  deleteFlow(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.knowledge.deleteFlow(scope, id);
  }
}
