import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';
import { AiService } from '../ai/ai.service';

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai:     AiService,
    @Optional() private readonly queue?: any,
  ) {}

  // ── AI billing helpers ──────────────────────────────────────────────────────

  private async guardAiAccess(scope: TenantScope): Promise<void> {
    const sub = await this.prisma.subscription.findUnique({
      where:   { tenantId: scope.tenantId },
      include: { plan: { select: { aiEnabled: true, aiCredits: true } } },
    });
    const plan = (sub as any)?.plan;
    if (plan && plan.aiEnabled === false) {
      throw new ForbiddenException('AI is not on your plan');
    }
    const aiCredits: number    = plan?.aiCredits    ?? 0;
    const aiCreditsUsed: number = (sub as any)?.aiCreditsUsed ?? 0;
    if (aiCredits > 0 && aiCreditsUsed >= aiCredits) {
      throw new ForbiddenException('AI credits exhausted for this billing period');
    }
    if (scope.userId) {
      const user = await this.prisma.user.findUnique({
        where:  { id: scope.userId },
        select: { aiCreditLimit: true, aiCreditsUsed: true },
      });
      const userLimit: number = (user as any)?.aiCreditLimit ?? 0;
      const userUsed: number  = (user as any)?.aiCreditsUsed  ?? 0;
      if (userLimit > 0 && userUsed >= userLimit) {
        throw new ForbiddenException('Your personal AI credit limit has been reached');
      }
    }
  }

  private async chargeAiCredit(scope: TenantScope): Promise<void> {
    await Promise.all([
      this.prisma.subscription.updateMany({
        where: { tenantId: scope.tenantId },
        data:  { aiCreditsUsed: { increment: 1 } } as any,
      }),
      scope.userId
        ? this.prisma.user.updateMany({
            where: { id: scope.userId, tenantId: scope.tenantId },
            data:  { aiCreditsUsed: { increment: 1 } } as any,
          })
        : Promise.resolve(),
    ]);
  }

  // ── Knowledge docs ──────────────────────────────────────────────────────────

  async listDocs(scope: TenantScope, query: { page?: number; limit?: number; search?: string }) {
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const skip  = (page - 1) * limit;
    const where: any = { tenantId: scope.tenantId, businessId: scope.businessId };
    if (query.search) where.name = { contains: query.search, mode: 'insensitive' };
    const [docs, total] = await Promise.all([
      this.prisma.knowledgeDoc.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      this.prisma.knowledgeDoc.count({ where }),
    ]);
    return { docs, total, page, limit };
  }

  async getDoc(scope: TenantScope, id: string) {
    const doc = await this.prisma.knowledgeDoc.findFirst({
      where: { id, tenantId: scope.tenantId, businessId: scope.businessId },
    });
    if (!doc) throw new NotFoundException('Knowledge doc not found');
    return doc;
  }

  async createDoc(scope: TenantScope, data: {
    name: string; type: string; url?: string; content?: string; metadata?: unknown;
  }) {
    const doc = await this.prisma.knowledgeDoc.create({
      data: {
        tenantId:   scope.tenantId,
        businessId: scope.businessId,
        name:       data.name,
        type:       data.type,
        url:        data.url,
        content:    data.content,
        metadata:   data.metadata as any,
        isIndexed:  false,
      },
    });
    if (this.queue && doc.content) {
      await this.queue.add('ingest', { docId: doc.id, businessId: scope.businessId });
    }
    return doc;
  }

  async updateDoc(scope: TenantScope, id: string, data: { name?: string }) {
    await this.getDoc(scope, id);
    return this.prisma.knowledgeDoc.update({
      where: { id },
      data:  { name: data.name },
    });
  }

  async deleteDoc(scope: TenantScope, id: string) {
    await this.getDoc(scope, id);
    await this.prisma.knowledgeDoc.delete({ where: { id } });
    return { success: true };
  }

  async reindexDoc(scope: TenantScope, id: string) {
    const doc = await this.getDoc(scope, id);
    if (!doc.content) {
      throw new BadRequestException('Document has no content to index. Re-upload the file first.');
    }
    const updated = await this.prisma.knowledgeDoc.update({
      where: { id },
      data:  { isIndexed: false, vectorIds: [], chunkCount: 0 },
    });
    if (this.queue) {
      await this.queue.add('ingest', { docId: id, businessId: scope.businessId });
    }
    return updated;
  }

  // ── FAQ state (stored in doc.metadata) ─────────────────────────────────────

  async getFaqState(scope: TenantScope, docId: string) {
    const doc  = await this.getDoc(scope, docId);
    const meta = (doc.metadata ?? {}) as Record<string, any>;
    return {
      faqs:        meta.faqs        ?? [],
      generatedAt: meta.faqUpdatedAt ?? null,
      style:       meta.faqStyle    ?? null,
      truncated:   meta.faqTruncated ?? false,
    };
  }

  async generateDocFaqs(scope: TenantScope, docId: string, force = false) {
    const doc  = await this.getDoc(scope, docId);
    const meta = (doc.metadata ?? {}) as Record<string, any>;

    if (!force && meta.faqs?.length > 0) {
      return { faqs: meta.faqs, generatedAt: meta.faqUpdatedAt ?? null, truncated: false, cached: true };
    }

    if (!doc.content) {
      throw new BadRequestException('Document has no content to generate FAQs from.');
    }

    await this.guardAiAccess(scope);
    const faqs = await this.ai.generateFaqs(doc.content, doc.name);
    await this.chargeAiCredit(scope);
    const generatedAt = new Date().toISOString();
    const truncated = (doc.content?.length ?? 0) > 4000;
    await this.prisma.knowledgeDoc.update({
      where: { id: docId },
      data:  {
        metadata: {
          ...(meta as any),
          faqs,
          faqGenerated: true,
          faqUpdatedAt: generatedAt,
          faqTruncated: truncated,
        },
      },
    });
    return { faqs, generatedAt, truncated, cached: false };
  }

  async saveFaqState(scope: TenantScope, docId: string, faqs: any[]) {
    const doc  = await this.getDoc(scope, docId);
    const meta = (doc.metadata ?? {}) as Record<string, any>;
    const updatedAt = new Date().toISOString();
    await this.prisma.knowledgeDoc.update({
      where: { id: docId },
      data:  {
        metadata: {
          ...(meta as any),
          faqs,
          faqUpdatedAt: updatedAt,
        },
      },
    });
    return { faqs, generatedAt: updatedAt, style: meta.faqStyle ?? null, truncated: meta.faqTruncated ?? false };
  }

  async answerDocFaq(scope: TenantScope, docId: string, index: number) {
    const doc  = await this.getDoc(scope, docId);
    const meta = (doc.metadata ?? {}) as Record<string, any>;
    const faqs = (meta.faqs ?? []) as any[];

    if (index < 0 || index >= faqs.length) {
      throw new BadRequestException('FAQ index out of range');
    }
    if (!doc.content) throw new BadRequestException('Document has no content');

    await this.guardAiAccess(scope);
    const faq    = faqs[index];
    const answer = await this.ai.answerQuestion(faq.question, doc.content);
    await this.chargeAiCredit(scope);
    faqs[index]  = { ...faq, answer };

    await this.prisma.knowledgeDoc.update({
      where: { id: docId },
      data:  { metadata: { ...(meta as any), faqs } },
    });

    return { index, item: faqs[index], state: { faqs, generated: meta.faqGenerated ?? false } };
  }

  // ── FAQ Sets ────────────────────────────────────────────────────────────────

  async listFaqSets(scope: TenantScope) {
    return this.prisma.knowledgeFaqSet.findMany({
      where:   { tenantId: scope.tenantId, businessId: scope.businessId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getFaqSet(scope: TenantScope, id: string) {
    const set = await this.prisma.knowledgeFaqSet.findFirst({
      where: { id, tenantId: scope.tenantId, businessId: scope.businessId },
    });
    if (!set) throw new NotFoundException('FAQ set not found');
    return set;
  }

  async createFaqSet(scope: TenantScope, data: {
    name: string; docIds?: string[]; faqs?: unknown; style?: unknown;
  }) {
    return this.prisma.knowledgeFaqSet.create({
      data: {
        tenantId:   scope.tenantId,
        businessId: scope.businessId,
        name:       data.name,
        docIds:     data.docIds ?? [],
        faqs:       (data.faqs ?? []) as any,
        style:      data.style as any,
      },
    });
  }

  async updateFaqSet(scope: TenantScope, id: string, data: {
    name?: string; docIds?: string[]; faqs?: unknown; style?: unknown;
    truncated?: boolean; error?: string;
  }) {
    await this.getFaqSet(scope, id);
    return this.prisma.knowledgeFaqSet.update({
      where: { id },
      data:  {
        name:      data.name,
        docIds:    data.docIds,
        faqs:      data.faqs as any,
        style:     data.style as any,
        truncated: data.truncated,
        error:     data.error ?? null,
      },
    });
  }

  async deleteFaqSet(scope: TenantScope, id: string) {
    await this.getFaqSet(scope, id);
    await this.prisma.knowledgeFaqSet.delete({ where: { id } });
    return { success: true };
  }

  async proposeFaqSetQuestions(scope: TenantScope, setId: string) {
    const set     = await this.getFaqSet(scope, setId);
    const docIds  = (set.docIds ?? []) as string[];
    const docs    = await Promise.all(
      docIds.map((id) =>
        this.prisma.knowledgeDoc.findFirst({
          where:  { id, tenantId: scope.tenantId },
          select: { name: true, content: true },
        }),
      ),
    );
    const validDocs = docs.filter((d): d is { name: string; content: string } =>
      !!d && !!d.content,
    );
    if (validDocs.length === 0) {
      throw new BadRequestException('No indexed documents with content found in this set');
    }
    await this.guardAiAccess(scope);
    const questions = await this.ai.proposeQuestions(
      validDocs.map((d) => ({ name: d.name, content: d.content })),
    );
    await this.chargeAiCredit(scope);
    await this.prisma.knowledgeFaqSet.update({
      where: { id: setId },
      data:  { style: { ...(set.style as any), proposedQuestions: questions } },
    });
    return { questions, setId };
  }

  async answerFaqSetQuestion(scope: TenantScope, setId: string, index: number) {
    const set  = await this.getFaqSet(scope, setId);
    const faqs = (set.faqs ?? []) as any[];

    if (index < 0 || index >= faqs.length) {
      throw new BadRequestException('FAQ index out of range');
    }

    const faq    = faqs[index];
    const docIds = (set.docIds ?? []) as string[];

    // Build combined content from all docs in the set
    const docs = await this.prisma.knowledgeDoc.findMany({
      where:  { id: { in: docIds }, tenantId: scope.tenantId },
      select: { content: true },
    });
    const combined = docs
      .map((d) => d.content ?? '')
      .filter(Boolean)
      .join('\n\n---\n\n')
      .slice(0, 6000);

    if (!combined) throw new BadRequestException('No content found in set documents');

    await this.guardAiAccess(scope);
    const answer = await this.ai.answerQuestion(faq.question, combined);
    await this.chargeAiCredit(scope);
    faqs[index]  = { ...faq, answer, source: docIds[0] ?? null };

    await this.prisma.knowledgeFaqSet.update({
      where: { id: setId },
      data:  { faqs: faqs as any },
    });

    return { index, item: faqs[index], set: { ...set, faqs } };
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  async searchKnowledge(scope: TenantScope, query: string, opts: { limit?: number; scoreThreshold?: number } = {}) {
    // Simple text search — replace with Qdrant vector search when available
    const limit = Math.min(20, opts.limit ?? 5);
    const docs  = await this.prisma.knowledgeDoc.findMany({
      where: {
        businessId: scope.businessId,
        content:    { contains: query, mode: 'insensitive' },
      },
      take: limit,
    });

    const results = docs.map((d, i) => ({
      docId:      d.id,
      docName:    d.name,
      docType:    d.type,
      chunkIndex: 0,
      score:      1 - i * 0.1,
      text:       (d.content ?? '').slice(0, 500),
    }));

    return { query, limit, scoreThreshold: opts.scoreThreshold ?? 0, results };
  }

  // ── FAQ Interest analytics ──────────────────────────────────────────────────

  async getFaqInterestStats(scope: TenantScope, days: number) {
    const since = new Date(Date.now() - days * 86400000);
    const rows  = await this.prisma.faqInteraction.findMany({
      where:   { tenantId: scope.tenantId, businessId: scope.businessId, createdAt: { gte: since } },
      include: { contact: { select: { id: true } } },
    });

    // Aggregate in memory — shape matches Next.js /api/knowledge/faqs/interest
    const map = new Map<string, { taps: number; contacts: Set<string>; buyingSignal: boolean; lastAsked: Date }>();
    for (const row of rows) {
      const q    = (row as any).question ?? 'Unknown';
      const prev = map.get(q) ?? { taps: 0, contacts: new Set(), buyingSignal: false, lastAsked: row.createdAt };
      prev.taps++;
      if ((row as any).contact?.id) prev.contacts.add((row as any).contact.id);
      if ((row as any).isBuyingSignal) prev.buyingSignal = true;
      if (row.createdAt > prev.lastAsked) prev.lastAsked = row.createdAt;
      map.set(q, prev);
    }

    const questions = Array.from(map.entries())
      .map(([question, v]) => ({
        question,
        intent:    null,
        taps:      v.taps,
        contacts:  v.contacts.size,
        lastAsked: v.lastAsked,
      }))
      .sort((a, b) => b.contacts - a.contacts || b.taps - a.taps)
      .slice(0, 25);

    return {
      days,
      totalTaps:      rows.length,
      uniqueContacts: new Set(rows.map((r) => (r as any).contact?.id).filter(Boolean)).size,
      buyingSignals:  rows.filter((r) => (r as any).isBuyingSignal).length,
      questions,
    };
  }

  async getFaqInterests(scope: TenantScope, query: { page?: number; limit?: number }) {
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const skip  = (page - 1) * limit;
    const where = { tenantId: scope.tenantId, businessId: scope.businessId };
    const [interactions, total] = await Promise.all([
      this.prisma.faqInteraction.findMany({
        where,
        skip,
        take:    limit,
        orderBy: { createdAt: 'desc' },
        include: { contact: { select: { id: true, name: true, phone: true } } },
      }),
      this.prisma.faqInteraction.count({ where }),
    ]);
    return { interactions, total, page, limit };
  }

  // ── Chatbot flows ───────────────────────────────────────────────────────────

  async listFlows(scope: TenantScope) {
    return this.prisma.chatbotFlow.findMany({
      where:   { tenantId: scope.tenantId, businessId: scope.businessId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getFlow(scope: TenantScope, id: string) {
    const flow = await this.prisma.chatbotFlow.findFirst({
      where: { id, tenantId: scope.tenantId, businessId: scope.businessId },
    });
    if (!flow) throw new NotFoundException('Flow not found');
    return flow;
  }

  async createFlow(scope: TenantScope, data: {
    name: string; description?: string; trigger: string;
    keywords?: string[]; nodes: unknown; edges: unknown;
  }) {
    return this.prisma.chatbotFlow.create({
      data: {
        tenantId:    scope.tenantId,
        businessId:  scope.businessId,
        name:        data.name,
        description: data.description,
        trigger:     data.trigger,
        keywords:    data.keywords ?? [],
        nodes:       data.nodes as any,
        edges:       data.edges as any,
        isActive:    false,
      },
    });
  }

  async updateFlow(scope: TenantScope, id: string, data: {
    name?: string; description?: string; trigger?: string;
    keywords?: string[]; nodes?: unknown; edges?: unknown; isActive?: boolean;
    publishedNodes?: unknown; publishedEdges?: unknown; isDraft?: boolean;
  }) {
    await this.getFlow(scope, id);
    return this.prisma.chatbotFlow.update({
      where: { id },
      data:  {
        name:           data.name,
        description:    data.description,
        trigger:        data.trigger,
        keywords:       data.keywords,
        nodes:          data.nodes as any,
        edges:          data.edges as any,
        isActive:       data.isActive,
      },
    });
  }

  async deleteFlow(scope: TenantScope, id: string) {
    await this.getFlow(scope, id);
    await this.prisma.chatbotFlow.delete({ where: { id } });
    return { success: true };
  }

  async duplicateFlow(scope: TenantScope, id: string) {
    const flow = await this.getFlow(scope, id);
    return this.prisma.chatbotFlow.create({
      data: {
        tenantId:    scope.tenantId,
        businessId:  scope.businessId,
        name:        `${flow.name} (Copy)`,
        description: flow.description,
        trigger:     flow.trigger,
        keywords:    flow.keywords,
        nodes:       flow.nodes as any,
        edges:       flow.edges as any,
        isActive:    false,
      },
    });
  }

  async publishFlow(scope: TenantScope, id: string) {
    await this.getFlow(scope, id);
    return this.prisma.chatbotFlow.update({
      where: { id },
      data:  { isActive: true },
    });
  }

  async draftFlow(scope: TenantScope, id: string) {
    await this.getFlow(scope, id);
    return this.prisma.chatbotFlow.update({
      where: { id },
      data:  { isActive: false },
    });
  }

  async previewFlow(scope: TenantScope, id: string, message: string) {
    const flow  = await this.getFlow(scope, id);
    const nodes = Array.isArray(flow.nodes) ? flow.nodes as any[] : [];
    const first = nodes[0] ?? null;
    return { node: first, response: first?.data?.message ?? first?.data?.text ?? null };
  }

  async validateFlow(scope: TenantScope, id: string) {
    const flow   = await this.getFlow(scope, id);
    const errors: string[] = [];
    const nodes  = Array.isArray(flow.nodes) ? flow.nodes as any[] : [];
    const edges  = Array.isArray(flow.edges) ? flow.edges as any[] : [];

    if (nodes.length === 0) errors.push('Flow has no nodes');
    if (edges.length === 0) errors.push('Flow has no edges');

    const nodeIds = new Set(nodes.map((n: any) => n.id));
    for (const edge of edges) {
      if (edge.target && !nodeIds.has(edge.target)) {
        errors.push(`Edge target "${edge.target}" does not exist`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  async autosaveFlow(scope: TenantScope, id: string, nodes: any, edges: any) {
    await this.getFlow(scope, id);
    const updated = await this.prisma.chatbotFlow.update({
      where: { id },
      data:  { nodes: nodes as any, edges: edges as any },
    });
    return updated;
  }

  // ── Send FAQ list as WhatsApp interactive message ────────────────────────────

  async sendFaqList(
    scope: TenantScope,
    body: { conversationId: string; kind: 'document' | 'set'; sourceId: string; bodyText?: string },
  ) {
    const { tenantId, businessId, userId } = scope;
    const { conversationId, kind, sourceId, bodyText } = body;

    if (!conversationId || !kind || !sourceId) {
      throw new BadRequestException('conversationId, kind, and sourceId are required');
    }

    const conversation = await this.prisma.conversation.findFirst({
      where:   { id: conversationId, tenantId, businessId },
      include: { contact: { select: { phone: true, optedOut: true } } },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.contact.optedOut) {
      throw new BadRequestException('This contact has opted out of messages.');
    }

    let title: string;
    let faqs: Array<{ question: string; answer?: string | null }> = [];

    if (kind === 'document') {
      const doc = await this.prisma.knowledgeDoc.findFirst({
        where:  { id: sourceId, tenantId, businessId },
        select: { name: true, metadata: true },
      });
      if (!doc) throw new NotFoundException('Document not found');
      title = doc.name;
      const meta = (doc.metadata ?? {}) as any;
      faqs = meta.faqs ?? [];
    } else {
      const set = await this.prisma.knowledgeFaqSet.findFirst({
        where:  { id: sourceId, tenantId, businessId },
        select: { name: true, faqs: true },
      });
      if (!set) throw new NotFoundException('FAQ set not found');
      title = set.name;
      faqs = (set.faqs as any[]) ?? [];
    }

    const answered = faqs.filter((f) => f.answer);
    if (answered.length === 0) {
      throw new BadRequestException('This list has no answered questions to send yet.');
    }

    // WhatsApp interactive list: max 10 rows per section, max 3 sections (30 total)
    const MAX_ROWS = 10;
    const sent    = answered.slice(0, MAX_ROWS);
    const dropped = answered.length - sent.length;

    const integration = await this.prisma.whatsAppIntegration.findFirst({
      where:  { businessId, tenantId, isActive: true },
      select: { phoneNumberId: true, accessToken: true },
    });
    if (!integration?.phoneNumberId || !integration.accessToken) {
      throw new BadRequestException('WhatsApp is not connected for this workspace');
    }

    const interactive = {
      type: 'list',
      body: { text: bodyText ?? `${title} — select a question to get an instant answer.` },
      action: {
        button:   'View questions',
        sections: [{
          title: title.slice(0, 24),
          rows:  sent.map((f, i) => ({
            id:    `faq_${kind}_${sourceId}_${i}`,
            title: f.question.slice(0, 24),
          })),
        }],
      },
    };

    const apiVer = process.env.WHATSAPP_API_VERSION ?? 'v20.0';
    const metaRes = await fetch(
      `https://graph.facebook.com/${apiVer}/${integration.phoneNumberId}/messages`,
      {
        method:  'POST',
        headers: {
          Authorization: `Bearer ${integration.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to:                conversation.contact.phone,
          type:              'interactive',
          interactive,
        }),
      },
    );
    if (!metaRes.ok) {
      const err: any = await metaRes.json().catch(() => ({}));
      throw new BadRequestException(err?.error?.message ?? 'Failed to send via WhatsApp');
    }
    const metaData: any = await metaRes.json();

    const message = await this.prisma.message.create({
      data: {
        tenantId,
        businessId,
        conversationId,
        sentById:    userId,
        waMessageId: metaData.messages?.[0]?.id ?? null,
        direction:   'OUTBOUND',
        status:      'SENT',
        type:        'INTERACTIVE' as any,
        content:     `${title} — ${sent.length} question${sent.length === 1 ? '' : 's'}`,
        metadata:    { interactive, faqMenu: { kind, sourceId, questions: sent.map((f) => f.question) } } as any,
      },
    });

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data:  { lastMessageAt: message.createdAt, lastMessagePreview: message.content ?? '' },
    });

    return { success: true, data: { message, sent: sent.length, dropped, maxRows: MAX_ROWS } };
  }
}
