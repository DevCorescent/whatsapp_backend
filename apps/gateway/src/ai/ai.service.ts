import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // ── Provider helpers ────────────────────────────────────────────────────────

  private get openRouterKey(): string | undefined {
    return this.config.get<string>('OPENROUTER_API_KEY');
  }

  private get groqKey(): string | undefined {
    return this.config.get<string>('GROQ_API_KEY');
  }

  private get aiModel(): string {
    return (
      this.config.get<string>('OPENROUTER_MODEL') ??
      'meta-llama/llama-3.3-70b-instruct'
    );
  }

  async callAi(
    systemPrompt: string,
    userPrompt: string,
    opts: { temperature?: number; json?: boolean } = {},
  ): Promise<string | null> {
    if (this.openRouterKey) {
      return this.callOpenRouter(systemPrompt, userPrompt, opts);
    }
    if (this.groqKey) {
      return this.callGroq(systemPrompt, userPrompt, opts);
    }
    return null;
  }

  private async callOpenRouter(
    systemPrompt: string,
    userPrompt: string,
    opts: { temperature?: number; json?: boolean } = {},
  ): Promise<string | null> {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${this.openRouterKey}`,
          'HTTP-Referer':  'https://whatscrm.app',
          'X-Title':       'WhatsCRM',
        },
        body: JSON.stringify({
          model:       this.aiModel,
          temperature: opts.temperature ?? 0.3,
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt },
          ],
        }),
      });
      if (!res.ok) {
        console.error('[AI] OpenRouter error', res.status, await res.text());
        return null;
      }
      const json: any = await res.json();
      return json?.choices?.[0]?.message?.content ?? null;
    } catch (err) {
      console.error('[AI] OpenRouter call failed', err);
      return null;
    }
  }

  private async callGroq(
    systemPrompt: string,
    userPrompt: string,
    opts: { temperature?: number } = {},
  ): Promise<string | null> {
    const model = this.config.get<string>('GROQ_MODEL') ?? 'llama-3.3-70b-versatile';
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${this.groqKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: opts.temperature ?? 0.3,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt },
          ],
        }),
      });
      if (!res.ok) return null;
      const json: any = await res.json();
      return json?.choices?.[0]?.message?.content ?? null;
    } catch {
      return null;
    }
  }

  private safeParseJson(text: string | null, fallback: any) {
    if (!text) return fallback;
    try {
      const match = text.match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : fallback;
    } catch {
      return fallback;
    }
  }

  // ── Billing guards ──────────────────────────────────────────────────────────

  async checkAiAccess(scope: TenantScope): Promise<void> {
    const sub = await this.prisma.subscription.findUnique({
      where:   { tenantId: scope.tenantId },
      include: { plan: { select: { aiEnabled: true, aiCredits: true } } },
    });

    const plan = (sub as any)?.plan;

    if (plan && plan.aiEnabled === false) {
      throw new ForbiddenException('AI is not on your plan');
    }

    const aiCredits: number = plan?.aiCredits ?? 0;
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

  private async incrementAiUsage(scope: TenantScope): Promise<void> {
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

  // ── Conversation helpers ────────────────────────────────────────────────────

  private async loadMessages(conversationId: string, businessId: string, take: number) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, businessId },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    const messages = await this.prisma.message.findMany({
      where:   { conversationId },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return messages.reverse();
  }

  private buildChatHistory(messages: any[]): { role: string; content: string }[] {
    return messages
      .filter((m) => m.type !== 'NOTE')
      .map((m) => ({
        role:    m.direction === 'INBOUND' ? 'user' : 'assistant',
        content: m.body ?? m.text ?? '',
      }));
  }

  // ── Qualify ─────────────────────────────────────────────────────────────────

  async qualify(scope: TenantScope, input: { conversationId?: string; leadId?: string }) {
    await this.checkAiAccess(scope);
    let conversationId = input.conversationId;

    // If leadId is provided, resolve it to the most recent conversation for that lead's contact
    if (!conversationId && input.leadId) {
      const lead = await this.prisma.lead.findFirst({
        where:  { id: input.leadId, tenantId: scope.tenantId },
        select: { contactId: true },
      });
      if (!lead) throw new NotFoundException('Lead not found');

      const latestConversation = await this.prisma.conversation.findFirst({
        where:   { contactId: lead.contactId, businessId: scope.businessId },
        orderBy: { updatedAt: 'desc' },
        select:  { id: true },
      });
      if (!latestConversation) throw new NotFoundException('No conversation found for this lead');
      conversationId = latestConversation.id;
    }

    if (!conversationId) throw new NotFoundException('conversationId or leadId is required');

    // Load conversation separately to obtain contactId for the write-back
    const conversation = await this.prisma.conversation.findFirst({
      where:  { id: conversationId, businessId: scope.businessId },
      select: { id: true, contactId: true },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');

    const messages = await this.loadMessages(conversationId, scope.businessId, 20);
    const history  = this.buildChatHistory(messages);

    const sys = `You are a CRM sales analyst. Analyze the conversation and return ONLY valid JSON:
{
  "bantBudget": "what you know about their budget",
  "bantAuthority": "who makes the decision",
  "bantNeed": "what problem they want to solve",
  "bantTimeline": "when they want to act",
  "score": 0,
  "scoreLabel": "COLD|WARM|HOT|QUALIFIED",
  "reasoning": "one sentence"
}`;

    const raw    = await this.callAi(sys, history.map((m) => `${m.role}: ${m.content}`).join('\n'), { json: true });
    const result = this.safeParseJson(raw, {
      bantBudget:    'Unknown', bantAuthority: 'Unknown',
      bantNeed:      'Unknown', bantTimeline:  'Unknown',
      score: 0, scoreLabel: 'COLD', reasoning: 'Insufficient data.',
    });

    await this.incrementAiUsage(scope);

    // Write qualification result back to the Lead record
    await this.prisma.lead.updateMany({
      where: { contactId: conversation.contactId, tenantId: scope.tenantId },
      data:  {
        score:           result.score ?? 0,
        scoreLabel:      result.scoreLabel ?? 'COLD',
        isDecisionMaker: (result.bantAuthority ?? 'Unknown') !== 'Unknown',
      },
    });

    return { success: true, data: result };
  }

  // ── Sentiment ───────────────────────────────────────────────────────────────

  async sentiment(scope: TenantScope, conversationId: string) {
    await this.checkAiAccess(scope);
    const messages = await this.loadMessages(conversationId, scope.businessId, 10);
    const history  = this.buildChatHistory(messages);

    const sys = `You are a sentiment analysis model. Return ONLY valid JSON:
{"sentiment":"positive|neutral|negative","confidence":0.5,"summary":"one sentence"}`;

    const raw = await this.callAi(sys, history.map((m) => `${m.role}: ${m.content}`).join('\n'), { json: true });
    const result = this.safeParseJson(raw, { sentiment: 'neutral', confidence: 0.5, summary: 'Unable to determine.' });
    await this.incrementAiUsage(scope);
    return result;
  }

  // ── Summarize ───────────────────────────────────────────────────────────────

  async summarize(scope: TenantScope, conversationId: string) {
    await this.checkAiAccess(scope);
    const messages = await this.loadMessages(conversationId, scope.businessId, 30);
    const history  = this.buildChatHistory(messages);

    const sys = `You are a CRM assistant. Summarize the conversation. Return ONLY valid JSON:
{"summary":"paragraph","keyPoints":["point"],"nextAction":"recommended next step"}`;

    const raw = await this.callAi(sys, history.map((m) => `${m.role}: ${m.content}`).join('\n'), { json: true });
    const result = this.safeParseJson(raw, { summary: 'No summary.', keyPoints: [], nextAction: 'Follow up.' });
    await this.incrementAiUsage(scope);
    return result;
  }

  // ── Streaming reply (SSE) ───────────────────────────────────────────────────

  async replyStream(
    scope: TenantScope,
    conversationId: string,
    userMessage: string | undefined,
    res: Response,
  ): Promise<void> {
    await this.checkAiAccess(scope);

    // Load conversation + messages + TenantSettings (aiModel/aiPersonality/aiEnabled live there)
    const [conversation, tenantSettings] = await Promise.all([
      this.prisma.conversation.findFirst({
        where:   { id: conversationId, businessId: scope.businessId },
        include: { business: { select: { aiSystemPrompt: true, aiResponseTone: true } } },
      }),
      this.prisma.tenantSettings.findUnique({
        where:  { tenantId: scope.tenantId },
        select: { aiEnabled: true, aiModel: true, aiPersonality: true },
      }),
    ]);
    if (!conversation) {
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (tenantSettings?.aiEnabled === false) {
      res.write(`data: ${JSON.stringify({ chunk: 'AI is disabled for this workspace.' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const messages = await this.prisma.message.findMany({
      where:   { conversationId, isNote: false },
      orderBy: { createdAt: 'desc' },
      take:    30,
    });
    const history = this.buildChatHistory(messages.reverse());

    // RAG: search knowledge base with the last inbound message
    const lastInbound = messages.filter(m => m.direction === 'INBOUND').pop();
    const ragQuery = (lastInbound as any)?.content ?? (lastInbound as any)?.body ?? '';
    let sources: any[] = [];
    let ragContext = '';

    if (ragQuery.trim().length > 3) {
      const docs = await this.prisma.knowledgeDoc.findMany({
        where: {
          businessId: scope.businessId,
          isIndexed:  true,
          content:    { contains: ragQuery.trim().slice(0, 80), mode: 'insensitive' },
        },
        take:   3,
        select: { id: true, name: true, type: true, content: true },
      });

      if (docs.length > 0) {
        sources = docs.map(d => ({
          docId:   d.id,
          docName: d.name,
          docType: d.type,
          text:    (d.content ?? '').slice(0, 300),
        }));
        ragContext = '\n\nRelevant knowledge base:\n' +
          docs.map(d => `[${d.name}]:\n${(d.content ?? '').slice(0, 500)}`).join('\n\n---\n\n');
      }
    }

    // Emit sources frame before the token stream
    if (sources.length > 0) {
      res.write(`data: ${JSON.stringify({ sources })}\n\n`);
    }

    const biz         = (conversation as any).business;
    const personality = tenantSettings?.aiPersonality ?? '';
    const systemParts = [
      biz?.aiSystemPrompt ?? 'You are a helpful WhatsApp CRM assistant.',
      personality ? `Personality: ${personality}` : '',
      biz?.aiResponseTone ? `Tone: ${biz.aiResponseTone}` : '',
      ragContext,
    ].filter(Boolean).join('\n');

    const apiKey = this.openRouterKey ?? this.groqKey;
    if (!apiKey) {
      res.write(`data: ${JSON.stringify({ chunk: 'AI service is not configured.' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const endpoint = this.openRouterKey
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : 'https://api.groq.com/openai/v1/chat/completions';

    // Prefer TenantSettings.aiModel (user-selected in settings UI) over env default
    const model = this.openRouterKey
      ? (tenantSettings?.aiModel ?? this.aiModel)
      : (this.config.get<string>('GROQ_MODEL') ?? 'llama-3.3-70b-versatile');

    const allMessages = [
      { role: 'system', content: systemParts },
      ...history,
      ...(userMessage ? [{ role: 'user', content: userMessage }] : []),
    ];

    try {
      const upstream = await fetch(endpoint, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
          ...(this.openRouterKey ? { 'HTTP-Referer': 'https://whatscrm.app', 'X-Title': 'WhatsCRM' } : {}),
        },
        body: JSON.stringify({ model, stream: true, messages: allMessages }),
      });

      if (!upstream.ok || !upstream.body) {
        res.write(`data: ${JSON.stringify({ chunk: 'AI service error.' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      await this.incrementAiUsage(scope).catch(() => {});

      const reader  = upstream.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const lines = decoder.decode(value, { stream: true }).split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') continue;

          try {
            const parsed = JSON.parse(payload);
            const chunk  = parsed?.choices?.[0]?.delta?.content;
            if (chunk) {
              res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
            }
          } catch {
            /* skip malformed chunk */
          }
        }
      }
    } catch (err) {
      console.error('[AI] stream error', err);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  }

  // ── FAQ / Knowledge AI helpers (used by KnowledgeService) ──────────────────

  async generateFaqs(content: string, docName: string): Promise<any[]> {
    const sys = `You are a knowledge base assistant. Given the following document, generate 5-10 frequently asked questions with answers. Return ONLY a JSON array:
[{"question":"...","answer":"...","category":"General"}]`;

    const raw = await this.callAi(sys, `Document: ${docName}\n\n${content.slice(0, 4000)}`, { temperature: 0.5 });
    if (!raw) return [];

    try {
      const match = raw.match(/\[[\s\S]*\]/);
      return match ? JSON.parse(match[0]) : [];
    } catch {
      return [];
    }
  }

  async answerQuestion(question: string, content: string): Promise<string> {
    const sys = `You are a helpful assistant. Answer the question based ONLY on the provided content. Be concise.`;
    const prompt = `Content:\n${content.slice(0, 4000)}\n\nQuestion: ${question}`;
    const raw = await this.callAi(sys, prompt, { temperature: 0.2 });
    return raw ?? 'Unable to generate an answer.';
  }

  async proposeQuestions(docs: { name: string; content: string }[]): Promise<string[]> {
    const sys = `You are a knowledge base curator. Based on the provided documents, propose 5-10 questions that customers commonly ask. Return ONLY a JSON array of question strings: ["question 1", "question 2"]`;
    const context = docs.map((d) => `${d.name}:\n${d.content.slice(0, 1500)}`).join('\n\n---\n\n');
    const raw = await this.callAi(sys, context, { temperature: 0.6 });
    if (!raw) return [];
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      return match ? JSON.parse(match[0]) : [];
    } catch {
      return [];
    }
  }
}
