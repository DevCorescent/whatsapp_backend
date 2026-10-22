import {
  Controller, Get, Post, Put, Patch, Delete,
  Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { KnowledgeService } from './knowledge.service';

/**
 * All routes match the Next.js /api/knowledge/* paths exactly.
 *
 * ROUTE ORDER matters in NestJS — static segments must appear before param
 * segments in the same controller to avoid shadowing. The order below is:
 *   1. /knowledge               (list/create docs)
 *   2. /knowledge/docs/*        (explicit docs prefix — legacy)
 *   3. /knowledge/faq-sets/*    (static segment)
 *   4. /knowledge/search        (static)
 *   5. /knowledge/faqs/interest (static — MUST be before :id routes)
 *   6. /knowledge/faqs/send     (static — MUST be before :id routes)
 *   7. /knowledge/faq-interests (legacy alias)
 *   8. /knowledge/flows/*       (chatbot flows — also exposed at /chatbot/flows)
 *   9. /knowledge/:id/faqs/*    (param + static)
 *  10. /knowledge/:id/*         (param — catch-all for docs by id)
 */
@ApiTags('knowledge')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly svc: KnowledgeService) {}

  // ── Docs — root paths (Next.js /api/knowledge) ─────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List knowledge docs' })
  listDocs(
    @CurrentTenant() scope: TenantScope,
    @Query('page')   page?: string,
    @Query('limit')  limit?: string,
    @Query('search') search?: string,
  ) {
    return this.svc.listDocs(scope, {
      page:  page  ? Number(page)  : undefined,
      limit: limit ? Number(limit) : undefined,
      search,
    });
  }

  @Post()
  @ApiOperation({ summary: 'Create a knowledge doc' })
  createDoc(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.createDoc(scope, body);
  }

  // ── Docs — /docs prefix (legacy NestJS paths) ──────────────────────────────

  @Get('docs')
  listDocsLegacy(
    @CurrentTenant() scope: TenantScope,
    @Query('page')   page?: string,
    @Query('limit')  limit?: string,
    @Query('search') search?: string,
  ) {
    return this.svc.listDocs(scope, {
      page:  page  ? Number(page)  : undefined,
      limit: limit ? Number(limit) : undefined,
      search,
    });
  }

  @Post('docs')
  createDocLegacy(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.createDoc(scope, body);
  }

  @Get('docs/:id')
  getDocLegacy(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.getDoc(scope, id);
  }

  @Patch('docs/:id')
  updateDocLegacy(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.svc.updateDoc(scope, id, body);
  }

  @Delete('docs/:id')
  @HttpCode(HttpStatus.OK)
  deleteDocLegacy(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.deleteDoc(scope, id);
  }

  @Post('docs/:id/reindex')
  reindexDocLegacy(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.reindexDoc(scope, id);
  }

  // ── FAQ Sets ────────────────────────────────────────────────────────────────

  @Get('faq-sets')
  @ApiOperation({ summary: 'List FAQ sets' })
  listFaqSets(@CurrentTenant() scope: TenantScope) {
    return this.svc.listFaqSets(scope);
  }

  @Post('faq-sets')
  @ApiOperation({ summary: 'Create a FAQ set' })
  createFaqSet(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.createFaqSet(scope, body);
  }

  // Static sub-paths of faq-sets/:id BEFORE the param route
  @Post('faq-sets/:id/questions')
  @ApiOperation({ summary: 'Propose questions for a FAQ set using AI' })
  proposeFaqSetQuestions(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.proposeFaqSetQuestions(scope, id);
  }

  @Post('faq-sets/:id/answer')
  @ApiOperation({ summary: 'Answer one question in a FAQ set using AI' })
  answerFaqSetQuestion(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body('index') index: number,
  ) {
    return this.svc.answerFaqSetQuestion(scope, id, index);
  }

  @Get('faq-sets/:id')
  @ApiOperation({ summary: 'Get a FAQ set' })
  getFaqSet(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.getFaqSet(scope, id);
  }

  @Put('faq-sets/:id')
  @ApiOperation({ summary: 'Update a FAQ set (PUT — full replace)' })
  updateFaqSetPut(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.svc.updateFaqSet(scope, id, body);
  }

  @Patch('faq-sets/:id')
  @ApiOperation({ summary: 'Update a FAQ set (PATCH — partial)' })
  updateFaqSet(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.svc.updateFaqSet(scope, id, body);
  }

  @Delete('faq-sets/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a FAQ set' })
  deleteFaqSet(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.deleteFaqSet(scope, id);
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  @Post('search')
  @ApiOperation({ summary: 'Search knowledge docs' })
  search(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { query: string; limit?: number; scoreThreshold?: number },
  ) {
    return this.svc.searchKnowledge(scope, body.query, {
      limit:          body.limit,
      scoreThreshold: body.scoreThreshold,
    });
  }

  // ── FAQ Interest analytics — STATIC paths, before :id ──────────────────────

  @Get('faqs/interest')
  @ApiOperation({ summary: 'FAQ interaction analytics (Next.js path)' })
  getFaqInterestStats(
    @CurrentTenant() scope: TenantScope,
    @Query('days') days?: string,
  ) {
    return this.svc.getFaqInterestStats(scope, days ? Number(days) : 30);
  }

  @Post('faqs/send')
  @ApiOperation({ summary: 'Send FAQ list as WhatsApp interactive message' })
  sendFaqs(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.sendFaqList(scope, body);
  }

  @Get('faq-interests')
  @ApiOperation({ summary: 'List FAQ interactions (legacy NestJS path)' })
  getFaqInterests(
    @CurrentTenant() scope: TenantScope,
    @Query('page')  page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.getFaqInterests(scope, {
      page:  page  ? Number(page)  : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ── Chatbot flows ───────────────────────────────────────────────────────────

  @Get('flows')
  @ApiOperation({ summary: 'List chatbot flows' })
  listFlows(@CurrentTenant() scope: TenantScope) {
    return this.svc.listFlows(scope);
  }

  @Post('flows')
  @ApiOperation({ summary: 'Create a chatbot flow' })
  createFlow(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.svc.createFlow(scope, body);
  }

  @Post('flows/:id/duplicate')
  @ApiOperation({ summary: 'Duplicate a chatbot flow' })
  duplicateFlow(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.duplicateFlow(scope, id);
  }

  @Post('flows/:id/publish')
  @ApiOperation({ summary: 'Publish (activate) a chatbot flow' })
  publishFlow(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.publishFlow(scope, id);
  }

  @Post('flows/:id/draft')
  @ApiOperation({ summary: 'Revert a flow to draft (deactivate)' })
  draftFlow(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.draftFlow(scope, id);
  }

  @Post('flows/:id/preview')
  @ApiOperation({ summary: 'Preview a flow with a test message' })
  previewFlow(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { message: string },
  ) {
    return this.svc.previewFlow(scope, id, body.message);
  }

  @Post('flows/:id/validate')
  @ApiOperation({ summary: 'Validate a flow structure' })
  validateFlow(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.validateFlow(scope, id);
  }

  @Post('flows/:id/autosave')
  @ApiOperation({ summary: 'Autosave flow nodes and edges' })
  autosaveFlow(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { nodes: any; edges: any },
  ) {
    return this.svc.autosaveFlow(scope, id, body.nodes, body.edges);
  }

  @Get('flows/:id')
  @ApiOperation({ summary: 'Get a chatbot flow' })
  getFlow(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.getFlow(scope, id);
  }

  @Patch('flows/:id')
  @ApiOperation({ summary: 'Update a chatbot flow' })
  updateFlow(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.svc.updateFlow(scope, id, body);
  }

  @Delete('flows/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a chatbot flow' })
  deleteFlow(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.deleteFlow(scope, id);
  }

  // ── Doc FAQs — /:id/faqs/* (param + static, BEFORE /:id catch-all) ─────────

  @Get(':id/faqs')
  @ApiOperation({ summary: 'Get FAQ state for a knowledge doc' })
  getFaqState(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.getFaqState(scope, id);
  }

  @Post(':id/faqs')
  @ApiOperation({ summary: 'Generate FAQs for a knowledge doc using AI' })
  generateFaqs(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body('force') force?: boolean,
  ) {
    return this.svc.generateDocFaqs(scope, id, force);
  }

  @Put(':id/faqs')
  @ApiOperation({ summary: 'Save FAQ state for a knowledge doc' })
  saveFaqState(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body('faqs') faqs: any[],
  ) {
    return this.svc.saveFaqState(scope, id, faqs);
  }

  @Post(':id/faqs/answer')
  @ApiOperation({ summary: 'Answer one FAQ question using AI' })
  answerFaq(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body('index') index: number,
  ) {
    return this.svc.answerDocFaq(scope, id, index);
  }

  @Post(':id/reindex')
  @ApiOperation({ summary: 'Force re-index a knowledge doc' })
  reindexDoc(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.reindexDoc(scope, id);
  }

  // ── Doc by id — LAST (param catch-all) ────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Get a knowledge doc by id' })
  getDoc(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.getDoc(scope, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a knowledge doc' })
  updateDoc(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.svc.updateDoc(scope, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a knowledge doc' })
  deleteDoc(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.deleteDoc(scope, id);
  }
}
