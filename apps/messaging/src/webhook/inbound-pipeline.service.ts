/**
 * Inbound message pipeline: chatbot flow execution + AI auto-reply.
 *
 * Called fire-and-forget from WebhookService after a new inbound message is saved.
 * Mirrors lib/inbound.ts in the Next.js app.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@lib/prisma';
import { Prisma } from '@prisma/client';
import { decryptSecret, RedisPubSubService } from '@lib/common';
import { runFlowStep } from './chatbot/engine';
import { toFlowDocument } from './chatbot/types';
import type { FlowVariables } from './chatbot/engine';

const DEFAULT_OPT_OUT = ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT'];
const DEFAULT_OPT_IN  = ['START', 'SUBSCRIBE', 'YES', 'HELLO', 'HELP'];
const AI_HISTORY_LIMIT = 20;
const WA_API_VERSION = 'v20.0';

interface WACreds { phoneNumberId: string; apiKey: string }

// ─────────────────────────────────────────────────────────────────────────────
// System-prompt builder (mirrors lib/aiInstructions.ts).
// Full structured-instructions compilation is not ported — we use the free-text
// prompt or personality when available, and fall back to a sensible default.
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPromptSimple(params: {
  aiSystemPrompt?: string | null;
  aiPersonality?:  string | null;
  aiInstructions?: unknown;
  businessName?:   string | null;
  isFirstReply?:   boolean;
}): string {
  const instr = params.aiInstructions as Record<string, string> | null | undefined;

  if (instr && typeof instr === 'object' && instr.role) {
    const parts: string[] = [];
    parts.push(`# ROLE\n${instr.role}`);
    if (params.businessName) parts.push(`You represent "${params.businessName}" and always speak as that business.`);
    if (instr.mode) parts.push(`# MODE\n${instr.mode}`);
    if (instr.greeting) {
      const greet = params.isFirstReply === true
        ? `Open with "${instr.greeting}", then answer.`
        : params.isFirstReply === false
          ? 'Do not greet — you have already greeted this customer.'
          : `Open the first reply only with "${instr.greeting}".`;
      parts.push(`# GREETING\n${greet}`);
    }
    if (instr.fallback) parts.push(`# WHEN UNKNOWN\n${instr.fallback}`);
    if (params.aiSystemPrompt?.trim()) parts.push(`# ADDITIONAL\n${params.aiSystemPrompt.trim()}`);
    return parts.join('\n\n');
  }

  const base = params.aiSystemPrompt?.trim() || params.aiPersonality?.trim();
  if (base) return base;

  return params.businessName
    ? `You are the WhatsApp assistant for "${params.businessName}". Answer customer questions helpfully and concisely.`
    : 'You are a helpful WhatsApp CRM assistant. Answer concisely.';
}

@Injectable()
export class InboundPipelineService {
  private readonly logger = new Logger(InboundPipelineService.name);

  constructor(
    private readonly prisma:  PrismaService,
    private readonly config:  ConfigService,
    private readonly pubSub:  RedisPubSubService,
  ) {}

  // ── Entry point ─────────────────────────────────────────────────────────────

  async process(opts: {
    tenantId:               string;
    businessId:             string;
    conversationId:         string;
    contactId:              string;
    content:                string;
    interactiveReplyId:     string | null;
  }): Promise<void> {
    const [conversation, contact] = await Promise.all([
      this.prisma.conversation.findUnique({ where: { id: opts.conversationId } }),
      this.prisma.contact.findUnique({ where: { id: opts.contactId } }),
    ]);
    if (!conversation || !contact) return;

    // Credentials belong to the conversation's own WA number (not the routed tenant's).
    const creds = await this.resolveWACreds(
      conversation.businessId,
      (conversation as any).whatsappIntegrationId ?? null,
    );

    // ── 1. Opt-out / opt-in ─────────────────────────────────────────────────
    // Load tenant-specific keywords (falls back to defaults if not configured)
    const bizData = await this.prisma.business.findFirst({
      where:  { id: opts.businessId },
      select: { aiInstructions: true },
    });
    const optCfg   = ((bizData?.aiInstructions as any)?.optOutConfig ?? {}) as Record<string, any>;
    const normalize = (arr: string[]) => arr.map(k => k.trim().toUpperCase().replace(/[^A-Z]/g, ''));
    const OPT_OUT  = new Set([...normalize(DEFAULT_OPT_OUT), ...normalize(optCfg.optOutKeywords ?? [])]);
    const OPT_IN   = new Set([...normalize(DEFAULT_OPT_IN),  ...normalize(optCfg.optInKeywords  ?? [])]);
    const optOutReply = optCfg.optOutReply ?? 'You have been unsubscribed and will no longer receive messages from us. Reply START to re-subscribe.';
    const optInReply  = optCfg.optInReply  ?? 'You have been re-subscribed and will receive messages from us again. Reply STOP to unsubscribe.';

    const keyword = opts.content.trim().toUpperCase().replace(/[^A-Z]/g, '');

    if (OPT_OUT.has(keyword)) {
      await this.prisma.contact.update({ where: { id: contact.id }, data: { optedOut: true } });
      if (creds) await this.sendText(creds, contact.phone, optOutReply).catch(() => {});
      return;
    }

    if (contact.optedOut) {
      if (OPT_IN.has(keyword)) {
        await this.prisma.contact.update({ where: { id: contact.id }, data: { optedOut: false } });
        if (creds) await this.sendText(creds, contact.phone, optInReply).catch(() => {});
      }
      return;
    }

    this.logger.log(`Pipeline start conv=${opts.conversationId} creds=${creds ? 'ok' : 'null'}`);

    // ── 2. Chatbot flow ──────────────────────────────────────────────────────
    const flowHandled = await this.executeFlow(
      opts.tenantId,
      opts.businessId,
      conversation,
      contact,
      opts.content,
      opts.interactiveReplyId,
      creds,
    );

    // ── 3. AI auto-reply fallback ────────────────────────────────────────────
    this.logger.log(`Pipeline flowHandled=${flowHandled} conv=${opts.conversationId}`);
    if (!flowHandled && creds) {
      const cfg = await this.resolveAutoReplyConfig(opts.tenantId, opts.businessId);
      this.logger.log(`AutoReply cfg: aiEnabled=${cfg.aiEnabled} autoReply=${cfg.autoReply} conv=${opts.conversationId}`);
      if (!cfg.aiEnabled || !cfg.autoReply) return;

      // Re-read per-thread AI toggle.
      const live = await this.prisma.conversation.findUnique({
        where:  { id: conversation.id },
        select: { isAiActive: true },
      });
      this.logger.log(`AutoReply isAiActive=${live?.isAiActive} conv=${opts.conversationId}`);
      if (!live?.isAiActive) return;

      const delayMs = (cfg.autoReplyDelay ?? 0) * 1000;
      const run = () => this.handleAutoReply(cfg, conversation, contact, creds).catch((err) =>
        this.logger.error(`handleAutoReply failed conv=${opts.conversationId}`, err?.message ?? err),
      );
      if (delayMs > 0) setTimeout(run, delayMs); else await run();
    }
  }

  // ── Chatbot flow execution ──────────────────────────────────────────────────

  private async executeFlow(
    tenantId:          string,
    businessId:        string,
    conversation:      any,
    contact:           any,
    inboundText:       string,
    inboundReplyId:    string | null,
    creds:             WACreds | null,
  ): Promise<boolean> {
    if (!creds) return false;

    let flowId: string | null = (conversation as any).activeFlowId ?? null;
    let fromNodeId: string | undefined = (conversation as any).activeNodeId ?? undefined;
    let vars: FlowVariables = ((conversation as any).flowVars as FlowVariables | null) ?? {};
    const isResuming = Boolean(flowId && fromNodeId);

    if (!isResuming) {
      if (!inboundText) return false;
      const normalised = inboundText.toLowerCase().trim();
      const tokens = normalised.split(/[^a-z0-9]+/).filter(Boolean);

      const activeFlows = await this.prisma.chatbotFlow.findMany({
        where:  { tenantId, businessId, isActive: true },
        select: { id: true, trigger: true, keywords: true, nodes: true, edges: true },
      });

      // Priority 1: KEYWORD
      let matched: typeof activeFlows[0] | undefined = activeFlows.find(
        (f) => f.trigger === 'KEYWORD' &&
          (f.keywords as string[]).some((kw: string) => {
            const k = kw.toLowerCase().trim();
            if (!k) return false;
            if (normalised === k) return true;
            if (k.includes(' ')) return normalised.includes(k);
            return tokens.includes(k);
          }),
      );

      // Priority 2: FIRST_MESSAGE
      if (!matched) {
        const firstMsgFlow = activeFlows.find((f) => f.trigger === 'FIRST_MESSAGE');
        if (firstMsgFlow) {
          const msgCount = await this.prisma.message.count({ where: { conversationId: conversation.id } });
          if (msgCount <= 1) matched = firstMsgFlow;
        }
      }

      // Priority 3: INBOUND catch-all
      if (!matched) matched = activeFlows.find((f) => f.trigger === 'INBOUND');
      if (!matched) return false;

      flowId     = matched.id;
      fromNodeId = undefined;
      vars       = {};
    }

    const flow = await this.prisma.chatbotFlow.findFirst({
      where: { id: flowId!, tenantId },
    });
    if (!flow) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data:  { activeFlowId: null, activeNodeId: null, flowVars: Prisma.JsonNull },
      });
      return false;
    }

    const doc    = toFlowDocument(flow.nodes, flow.edges);
    const result = await runFlowStep(doc, {
      fromNodeId,
      input:     isResuming ? (inboundText ?? '') : undefined,
      replyId:   inboundReplyId,
      variables: vars,
      executors: {
        callAi: async (node, nodeVars) => {
          const prompt = node.prompt ?? 'Answer the customer message helpfully.';
          return this.callAi(prompt, nodeVars, node.model, node.temperature);
        },
      },
    });

    // Send every outbound action to the customer.
    let sentCount = 0;
    for (const action of result.actions) {
      if (action.type === 'menu' && action.menu) {
        try {
          await this.sendInteractive(creds, contact.phone, action.menu.interactive);
          sentCount += 1;
        } catch {
          try {
            await this.sendText(creds, contact.phone, action.menu.text);
            sentCount += 1;
          } catch { /* skip */ }
        }
        continue;
      }
      if ((action.type === 'message' || action.type === 'ai') && action.text) {
        try {
          await this.sendText(creds, contact.phone, action.text);
          sentCount += 1;
        } catch { /* skip */ }
      }
    }

    // Persist / clear session state.
    if (result.status === 'awaiting_input' && result.awaitingQuestionId) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data:  {
          activeFlowId: flow.id,
          activeNodeId: result.awaitingQuestionId,
          flowVars:     result.variables as any,
        },
      });
      return true;
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data:  { activeFlowId: null, activeNodeId: null, flowVars: Prisma.JsonNull },
    });

    // Handoff: assign to a human agent.
    if (result.handoff) {
      await this.assignConversationToAgent(conversation).catch(() => {});
      return true;
    }

    if (sentCount === 0) {
      this.logger.warn(`Flow ${flow.id} matched but sent nothing — falling through to AI`);
      return false;
    }
    return true;
  }

  // ── AI auto-reply ───────────────────────────────────────────────────────────

  private async searchKnowledgeBase(businessId: string, query: string): Promise<string> {
    if (!query.trim()) return '';
    try {
      const trimmed = query.trim();
      const isShortQuery = trimmed.split(/\s+/).length <= 3;

      // For short/greeting messages ("Hi", "Hello", "test") there's nothing to ILIKE-match,
      // so we load all indexed docs to give the AI business context regardless.
      // For longer messages we try a content match first, then fall back to all docs.
      let docs = await this.prisma.knowledgeDoc.findMany({
        where: isShortQuery
          ? { businessId, isIndexed: true }
          : { businessId, isIndexed: true, content: { contains: trimmed, mode: 'insensitive' } },
        take: 3,
        select: { name: true, content: true, metadata: true },
      });

      // Fallback: long query had no ILIKE hits → still inject top docs for context
      if (!docs.length && !isShortQuery) {
        docs = await this.prisma.knowledgeDoc.findMany({
          where: { businessId, isIndexed: true },
          take:  3,
          select: { name: true, content: true, metadata: true },
        });
      }

      this.logger.log(`KB search businessId=${businessId} query="${trimmed.slice(0, 40)}" found=${docs.length} docs isShort=${isShortQuery}`);

      if (!docs.length) return '';

      const snippets: string[] = [];
      for (const doc of docs) {
        const text = (doc.content ?? '').slice(0, 600);
        if (text) snippets.push(`[${doc.name}]\n${text}`);
        // Include FAQs from metadata
        const meta = doc.metadata as { faqs?: { question: string; answer: string }[] } | null;
        if (meta?.faqs?.length) {
          const relevant = meta.faqs.filter(f =>
            f.question.toLowerCase().includes(trimmed.toLowerCase().slice(0, 30)) ||
            trimmed.toLowerCase().includes(f.question.toLowerCase().slice(0, 30))
          ).slice(0, 3);
          for (const faq of relevant) {
            snippets.push(`Q: ${faq.question}\nA: ${faq.answer}`);
          }
        }
      }
      return snippets.join('\n\n');
    } catch {
      return '';
    }
  }

  private async handleAutoReply(
    cfg:          Awaited<ReturnType<typeof this.resolveAutoReplyConfig>>,
    conversation: any,
    contact:      any,
    creds:        WACreds,
  ): Promise<void> {
    const messages = await this.prisma.message.findMany({
      where:   { conversationId: conversation.id, isNote: false },
      orderBy: { createdAt: 'asc' },
      take:    AI_HISTORY_LIMIT,
    });

    const history = messages
      .filter((m: any) => m.content?.trim())
      .map((m: any) => ({
        role:    (m.direction === 'INBOUND' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: (m.content ?? '') as string,
      }));

    if (!history.length) return;

    const priorOutbound = await this.prisma.message.count({
      where: { conversationId: conversation.id, direction: 'OUTBOUND', isNote: false },
    });
    const isFirstReply = priorOutbound === 0;

    // ── First reply: always send the KB FAQ menu instead of an AI response ──────
    if (isFirstReply) {
      const faqs = await this.getKnowledgeBaseFaqs(conversation.businessId);
      if (faqs.length > 0) {
        this.logger.log(`AutoReply first-reply FAQ menu: ${faqs.length} FAQs conv=${conversation.id}`);
        const greeting = this.buildFaqGreeting(cfg.businessName, faqs);
        await this.sendAndPersistReply(greeting, conversation, contact, creds);
        return;
      }
      // No FAQs in KB → fall through to AI with context
    }

    // ── Subsequent replies (or first reply with no FAQs): AI with KB context ────
    const lastUserMsg = [...history].reverse().find(m => m.role === 'user')?.content ?? '';
    const kbContext   = await this.searchKnowledgeBase(conversation.businessId, lastUserMsg);

    const basePrompt  = buildSystemPromptSimple({
      aiSystemPrompt: cfg.aiSystemPrompt,
      aiPersonality:  cfg.aiPersonality,
      aiInstructions: cfg.aiInstructions,
      businessName:   cfg.businessName,
      isFirstReply,
    });
    const systemPrompt = kbContext
      ? `${basePrompt}\n\n# KNOWLEDGE BASE\nUse the following information to answer the customer. Only use facts from this section — do not invent details.\n\n${kbContext}`
      : basePrompt;

    const reply = await this.generateReply(
      history,
      systemPrompt,
      cfg.aiModel ?? undefined,
      cfg.aiTemperature ?? undefined,
      cfg.aiMaxTokens ?? undefined,
    );
    if (!reply?.trim()) return;

    await this.sendAndPersistReply(reply, conversation, contact, creds);
  }

  private async sendAndPersistReply(
    text:         string,
    conversation: any,
    contact:      any,
    creds:        WACreds,
  ): Promise<void> {
    let waMessageId: string | null = null;
    try {
      const sent = await this.sendText(creds, contact.phone, text);
      waMessageId = sent?.messages?.[0]?.id ?? null;
    } catch (err) {
      this.logger.error(`Failed to send reply to ${contact.phone}`, err);
      return;
    }

    await this.prisma.message.create({
      data: {
        tenantId:       conversation.tenantId,
        businessId:     conversation.businessId,
        conversationId: conversation.id,
        direction:      'OUTBOUND',
        status:         'SENT',
        type:           'TEXT',
        content:        text,
        waMessageId,
        isAiGenerated:  true,
        isNote:         false,
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data:  { lastMessageAt: new Date(), lastMessagePreview: text.slice(0, 100) },
    });
    this.pubSub.publish(conversation.tenantId, { event: 'new-message', conversationId: conversation.id }).catch(() => {});
  }

  private async getKnowledgeBaseFaqs(businessId: string): Promise<{ question: string; answer: string }[]> {
    try {
      const docs = await this.prisma.knowledgeDoc.findMany({
        where:  { businessId, isIndexed: true },
        take:   5,
        select: { metadata: true },
      });
      const faqs: { question: string; answer: string }[] = [];
      for (const doc of docs) {
        const meta = doc.metadata as { faqs?: { question: string; answer: string }[] } | null;
        if (meta?.faqs?.length) faqs.push(...meta.faqs);
      }
      return faqs.slice(0, 8); // max 8 to keep message readable
    } catch {
      return [];
    }
  }

  private buildFaqGreeting(businessName: string | null, faqs: { question: string; answer: string }[]): string {
    const name = businessName ?? 'us';
    const nums = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣'];
    const lines = faqs.map((f, i) => `${nums[i] ?? `${i + 1}.`} ${f.question}`).join('\n');
    return `Hello! 👋 Welcome to ${name}.\n\nHere are some topics I can help you with:\n\n${lines}\n\nReply with a number or type your question!`;
  }

  // ── Config resolution ───────────────────────────────────────────────────────

  private async resolveAutoReplyConfig(tenantId: string, businessId: string) {
    const [business, tenant] = await Promise.all([
      this.prisma.business.findUnique({
        where:  { id: businessId },
        select: {
          aiEnabled: true, autoReply: true, autoReplyDelay: true,
          aiModel: true, aiPersonality: true, aiSystemPrompt: true,
          aiInstructions: true, aiTemperature: true, aiMaxTokens: true, name: true,
        },
      }),
      this.prisma.tenantSettings.findUnique({
        where:  { tenantId },
        select: { aiEnabled: true, autoReply: true, autoReplyDelay: true, aiModel: true, aiPersonality: true },
      }),
    ]);

    const aiEnabled  = Boolean((business as any)?.aiEnabled  || (tenant as any)?.aiEnabled);
    const autoReply  = Boolean((business as any)?.autoReply  || (tenant as any)?.autoReply);

    return {
      aiEnabled,
      autoReply,
      autoReplyDelay: (business as any)?.autoReplyDelay ?? (tenant as any)?.autoReplyDelay ?? 0,
      aiModel:        (tenant as any)?.aiModel        || (business as any)?.aiModel,
      aiPersonality:  (tenant as any)?.aiPersonality  || (business as any)?.aiPersonality,
      aiSystemPrompt: (business as any)?.aiSystemPrompt ?? null,
      aiInstructions: (business as any)?.aiInstructions ?? null,
      aiTemperature:  (business as any)?.aiTemperature  ?? null,
      aiMaxTokens:    (business as any)?.aiMaxTokens    ?? null,
      businessName:   (business as any)?.name ?? null,
    };
  }

  // ── WhatsApp credential resolution ─────────────────────────────────────────

  private async resolveWACreds(businessId: string, integrationId: string | null): Promise<WACreds | null> {
    if (integrationId) {
      const row = await this.prisma.whatsAppIntegration.findUnique({
        where:  { id: integrationId },
        select: { phoneNumberId: true, accessToken: true, isActive: true, businessId: true },
      });
      if (row?.isActive && row.businessId === businessId && row.accessToken) {
        const token = decryptSecret(row.accessToken);
        if (token && row.phoneNumberId) return { phoneNumberId: row.phoneNumberId, apiKey: token };
      }
    }

    // Fall back to the business's default active integration.
    const integration = await this.prisma.whatsAppIntegration.findFirst({
      where:   { businessId, isActive: true, isDefault: true },
      select:  { phoneNumberId: true, accessToken: true },
      orderBy: { createdAt: 'asc' },
    }) ?? await this.prisma.whatsAppIntegration.findFirst({
      where:   { businessId, isActive: true },
      select:  { phoneNumberId: true, accessToken: true },
      orderBy: { createdAt: 'asc' },
    });

    if (integration?.accessToken && integration.phoneNumberId) {
      const token = decryptSecret(integration.accessToken);
      if (token) return { phoneNumberId: integration.phoneNumberId, apiKey: token };
    }

    // Legacy business-level credential.
    const biz = await this.prisma.business.findUnique({
      where:  { id: businessId },
      select: { whatsappPhoneNumberId: true, whatsappAccessToken: true },
    });
    if (biz?.whatsappPhoneNumberId && biz.whatsappAccessToken) {
      const token = decryptSecret(biz.whatsappAccessToken);
      if (token) return { phoneNumberId: biz.whatsappPhoneNumberId, apiKey: token };
    }

    return null;
  }

  // ── Meta API helpers ────────────────────────────────────────────────────────

  private async sendText(creds: WACreds, to: string, text: string): Promise<any> {
    const res = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/${creds.phoneNumberId}/messages`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
        body:    JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
      },
    );
    if (!res.ok) throw new Error(`Meta ${res.status}: ${await res.text()}`);
    return res.json();
  }

  private async sendInteractive(creds: WACreds, to: string, interactive: Record<string, unknown>): Promise<any> {
    const res = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/${creds.phoneNumberId}/messages`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
        body:    JSON.stringify({ messaging_product: 'whatsapp', to, type: 'interactive', interactive }),
      },
    );
    if (!res.ok) throw new Error(`Meta ${res.status}: ${await res.text()}`);
    return res.json();
  }

  // ── AI helpers ──────────────────────────────────────────────────────────────

  private async generateReply(
    history:       { role: 'user' | 'assistant'; content: string }[],
    systemPrompt:  string,
    model?:        string,
    temperature?:  number | null,
    maxTokens?:    number | null,
  ): Promise<string | null> {
    const openRouterKey = this.config.get<string>('OPENROUTER_API_KEY', '');
    const groqKey       = this.config.get<string>('GROQ_API_KEY', '');
    const apiKey        = openRouterKey || groqKey;
    if (!apiKey) return null;

    const endpoint = openRouterKey
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : 'https://api.groq.com/openai/v1/chat/completions';

    const defaultModel = openRouterKey
      ? (this.config.get<string>('OPENROUTER_MODEL') ?? 'meta-llama/llama-3.3-70b-instruct')
      : (this.config.get<string>('GROQ_MODEL') ?? 'llama-3.3-70b-versatile');

    // For OpenRouter, a model id must contain "/" to be valid; otherwise use the default.
    const resolvedModel = openRouterKey
      ? (model?.includes('/') ? model : defaultModel)
      : defaultModel;

    const messages = [{ role: 'system', content: systemPrompt }, ...history];

    this.logger.log(`generateReply model=${resolvedModel} msgs=${history.length}`);
    try {
      const res = await fetch(endpoint, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          Authorization:   `Bearer ${apiKey}`,
          ...(openRouterKey ? { 'HTTP-Referer': 'https://whatscrm.app', 'X-Title': 'WhatsCRM' } : {}),
        },
        body: JSON.stringify({
          model:       resolvedModel,
          messages,
          max_tokens:  maxTokens ?? 500,
          temperature: temperature ?? 0.7,
        }),
      });
      if (!res.ok) {
        this.logger.error(`LLM ${res.status}: ${await res.text()}`);
        return null;
      }
      const json: any = await res.json();
      return json?.choices?.[0]?.message?.content ?? null;
    } catch (err: any) {
      this.logger.error('generateReply fetch failed', err?.message);
      return null;
    }
  }

  private async callAi(
    prompt:      string,
    vars:        FlowVariables,
    model?:      string,
    temperature?: number,
  ): Promise<string> {
    const rendered = prompt.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
    const reply = await this.generateReply(
      [{ role: 'user', content: rendered }],
      'You are a helpful assistant.',
      model,
      temperature,
    );
    return reply ?? '';
  }

  // ── Handoff assignment ──────────────────────────────────────────────────────

  private async assignConversationToAgent(conversation: any): Promise<void> {
    if (conversation.assignedToId) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data:  { isAiActive: false },
      });
      return;
    }

    const agents = await this.prisma.user.findMany({
      where:  { tenantId: conversation.tenantId, isActive: true, role: { in: ['AGENT', 'MANAGER', 'ADMIN', 'TENANT_OWNER'] } },
      select: { id: true, _count: { select: { assignedConvs: { where: { status: { in: ['OPEN', 'ASSIGNED'] } } } } } },
    });

    let assignedToId: string | null = null;
    if (agents.length > 0) {
      agents.sort((a: any, b: any) =>
        a._count.assignedConvs - b._count.assignedConvs || a.id.localeCompare(b.id),
      );
      assignedToId = agents[0].id;
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data:  {
        isAiActive:   false,
        ...(assignedToId ? { assignedToId, status: 'ASSIGNED' } : {}),
      },
    });
  }

}
