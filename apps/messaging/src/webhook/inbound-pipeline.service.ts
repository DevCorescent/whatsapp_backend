/**
 * Inbound message pipeline: chatbot flow execution + AI auto-reply.
 *
 * Called fire-and-forget from WebhookService after a new inbound message is saved.
 * Mirrors lib/inbound.ts in the Next.js app.
 */
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@lib/prisma';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  decryptSecret, MessageEventsService, HandoverService, LeadQualificationService, LlmService,
  NotificationsService, MANAGER_ROLES,
} from '@lib/common';
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
    private readonly events:  MessageEventsService,
    private readonly handover: HandoverService,
    private readonly qualification: LeadQualificationService,
    private readonly llm: LlmService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Entry point ─────────────────────────────────────────────────────────────

  async process(opts: {
    tenantId:               string;
    businessId:             string;
    conversationId:         string;
    contactId:              string;
    content:                string;
    interactiveReplyId:     string | null;
    contactCreated?:        boolean;
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

    if (opts.contactCreated) {
      const triggered = await this.triggerFlowForEvent({
        tenantId: opts.tenantId,
        businessId: opts.businessId,
        contactId: contact.id,
        conversationId: conversation.id,
        trigger: 'CONTACT_CREATED',
        variables: { contactName: contact.name, contactPhone: contact.phone },
      });
      if (triggered.triggered) return;
    }

    this.logger.log(`Pipeline start conv=${opts.conversationId} creds=${creds ? 'ok' : 'null'}`);

    // ── 1b. Does this message need a person? ─────────────────────────────────
    // Checked before the flow and the AI, because someone who has asked for a human
    // should not be answered by a robot first.
    if (await this.checkHandoverTriggers(opts, conversation, contact, creds)) return;

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

    // ── 4. Score the conversation as a lead ──────────────────────────────────
    // Last, and never blocking the reply: the customer should not wait on a model that
    // is only writing to our own pipeline.
    void this.maybeQualify(opts.conversationId, 'AFTER_MESSAGES');
  }

  // ── Handing over to a person ────────────────────────────────────────────────

  /**
   * The triggers a business can switch on, in the order they are worth checking.
   *
   * Returns true when the conversation now belongs to a person, which stops the flow and
   * the auto-reply from running over the top of them.
   */
  private async checkHandoverTriggers(
    opts: { tenantId: string; businessId: string; conversationId: string; content: string },
    conversation: any,
    contact: any,
    creds: WACreds | null,
  ): Promise<boolean> {
    const config = await this.handover.configFor(opts.businessId).catch(() => null);
    if (config && !config.enabled) return false;

    // Already with a person and the AI is off: nothing more to decide.
    if (conversation.assignedToId && conversation.isAiActive === false) return false;

    let reason: 'CUSTOMER_REQUEST' | 'AFTER_REPLIES' | 'OFF_HOURS' | 'AI_UNSURE' | 'NEGATIVE_SENTIMENT' | null = null;
    let trigger: string | null = null;

    if (config?.onCustomerRequest !== false) {
      const matched = this.handover.asksForHuman(opts.content, config);
      if (matched) { reason = 'CUSTOMER_REQUEST'; trigger = opts.content.slice(0, 500); }
    }

    if (!reason && config?.afterAiReplies && config.afterAiReplies > 0) {
      // Consecutive AI replies since the last time a person said anything.
      const lastHuman = await this.prisma.message.findFirst({
        where:   { conversationId: opts.conversationId, direction: 'OUTBOUND', sentById: { not: null } },
        orderBy: { createdAt: 'desc' },
        select:  { createdAt: true },
      });
      const aiReplies = await this.prisma.message.count({
        where: {
          conversationId: opts.conversationId,
          direction:      'OUTBOUND',
          sentById:       null,
          ...(lastHuman ? { createdAt: { gt: lastHuman.createdAt } } : {}),
        },
      });
      if (aiReplies >= config.afterAiReplies) {
        reason = 'AFTER_REPLIES';
        trigger = `${aiReplies} AI replies with no human involved`;
      }
    }

    if (!reason && config?.offHours && !(await this.withinBusinessHours(opts.tenantId, opts.businessId))) {
      reason = 'OFF_HOURS';
    }

    // Both of these need the model's read of the message, so they share one call and it
    // only happens for a business that asked for it.
    if (!reason && (config?.onAiUnsure || config?.onNegativeSentiment)) {
      const assessment = await this.handover.assess(opts.content);
      if (assessment) {
        if (config.onAiUnsure && (assessment.needsHuman || assessment.confidence < config.aiUnsureThreshold)) {
          reason = 'AI_UNSURE';
          trigger = assessment.needsHuman
            ? 'The model judged this as needing a person'
            : `The model was only ${assessment.confidence}% confident it could answer`;
        } else if (config.onNegativeSentiment && assessment.sentiment === 'negative') {
          reason = 'NEGATIVE_SENTIMENT';
          trigger = opts.content.slice(0, 500);
        }
      }
    }

    if (!reason) return false;

    const outcome = await this.handover.request({
      conversationId: opts.conversationId,
      reason,
      trigger,
    }).catch((err: any) => {
      this.logger.error(`Handover failed for ${opts.conversationId}: ${err?.message ?? err}`);
      return null;
    });
    if (!outcome) return false;

    // Tell the customer somebody is coming, if the business wrote a line for it.
    const message = config?.customerMessage?.trim();
    if (message && creds) {
      await this.sendText(creds, contact.phone, message).catch(() => {});
    }

    void this.events.conversationUpdated(opts.conversationId);
    // A handover is also a good moment to judge the lead, if that is the chosen trigger.
    void this.maybeQualify(opts.conversationId, 'ON_HANDOVER');
    return true;
  }

  /** Whether now is inside the business hours set in general settings. */
  private async withinBusinessHours(tenantId: string, businessId: string): Promise<boolean> {
    const settings = await this.prisma.tenantSettings.findFirst({
      where:  { tenantId },
      select: { businessHoursStart: true, businessHoursEnd: true, businessDays: true },
    }).catch(() => null);
    const business = await this.prisma.business.findUnique({
      where: { id: businessId }, select: { timezone: true },
    }).catch(() => null);

    // Nothing configured means always open, which is how the rest of the app reads it.
    if (!settings?.businessHoursStart || !settings?.businessHoursEnd) return true;

    const zone = business?.timezone || 'Asia/Kolkata';
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    }).formatToParts(now);
    const hour   = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';

    const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
    const days = Array.isArray(settings.businessDays) ? (settings.businessDays as number[]) : null;
    if (days?.length && dayIndex >= 0 && !days.includes(dayIndex)) return false;

    const toMinutes = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number);
      return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
    };
    const nowMinutes = hour * 60 + minute;
    const start = toMinutes(settings.businessHoursStart);
    const end   = toMinutes(settings.businessHoursEnd);
    // An end before the start means the window runs past midnight.
    return end >= start
      ? nowMinutes >= start && nowMinutes <= end
      : nowMinutes >= start || nowMinutes <= end;
  }

  /** Score the conversation when the business's trigger says to, never blocking a reply. */
  /** The people in a named department, for a flow's notify node. */
  private async departmentMemberIds(businessId: string, name?: string): Promise<string[]> {
    const wanted = name?.trim();
    const department = await this.prisma.department.findFirst({
      where: wanted
        ? { businessId, enabled: true, name: { equals: wanted, mode: 'insensitive' } }
        : { businessId, enabled: true, isDefault: true },
      select: { members: { select: { userId: true } } },
    });
    return department?.members.map((m) => m.userId) ?? [];
  }

  private async maybeQualify(conversationId: string, trigger: 'AFTER_MESSAGES' | 'ON_HANDOVER' | 'ON_CLOSE'): Promise<void> {
    try {
      if (!(await this.qualification.isDue(conversationId, trigger))) return;
      const result = await this.qualification.qualify(conversationId);
      if (result.status === 'created' || result.status === 'updated') {
        this.logger.log(`Lead ${result.status} from ${conversationId}: ${result.score} (${result.label})`);
      }
    } catch (err: any) {
      this.logger.warn(`Lead qualification failed for ${conversationId}: ${err?.message ?? err}`);
    }
  }

  async triggerFlowForEvent(opts: {
    tenantId: string;
    businessId: string;
    contactId: string;
    conversationId?: string;
    trigger: 'CONTACT_CREATED' | 'LEAD_CREATED' | 'LEAD_STATUS_CHANGED' | 'LEAD_CLOSED';
    variables?: FlowVariables;
  }) {
    const flow = await this.prisma.chatbotFlow.findFirst({
      where: {
        tenantId: opts.tenantId,
        businessId: opts.businessId,
        trigger: opts.trigger,
        isActive: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!flow) return { triggered: false };

    const contact = await this.prisma.contact.findFirst({
      where: { id: opts.contactId, tenantId: opts.tenantId, businessId: opts.businessId },
    });
    if (!contact) throw new NotFoundException('Contact not found for flow trigger');

    const conversation = opts.conversationId
      ? await this.prisma.conversation.findFirst({
          where: {
            id: opts.conversationId,
            tenantId: opts.tenantId,
            businessId: opts.businessId,
            contactId: opts.contactId,
          },
        })
      : undefined;
    if (opts.conversationId && !conversation) return { triggered: false };

    return this.startTriggeredFlow(flow, contact, opts.variables ?? {}, conversation);
  }

  async triggerWebhookFlow(
    token: string,
    body: { contactId?: string; phone?: string; name?: string; variables?: Record<string, unknown> },
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException('Webhook not found');
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('A JSON request body is required');
    }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const flow = await this.prisma.chatbotFlow.findUnique({ where: { webhookTokenHash: tokenHash } });
    if (!flow || !flow.isActive || flow.trigger !== 'WEBHOOK') {
      throw new NotFoundException('Webhook not found');
    }

    const contactId = typeof body?.contactId === 'string' ? body.contactId.trim() : '';
    const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
    if (!contactId && !phone) {
      throw new BadRequestException('contactId or phone is required');
    }
    if (phone && !/^\+?[0-9][0-9\s().-]{4,30}$/.test(phone)) {
      throw new BadRequestException('phone must be a valid phone number');
    }

    let contact = contactId
      ? await this.prisma.contact.findFirst({
          where: { id: contactId, tenantId: flow.tenantId, businessId: flow.businessId },
        })
      : null;

    if (!contact && phone) {
      contact = await this.prisma.contact.upsert({
        where: { phone_businessId: { phone, businessId: flow.businessId } },
        create: {
          tenantId: flow.tenantId,
          businessId: flow.businessId,
          phone,
          name: typeof body.name === 'string' && body.name.trim()
            ? body.name.trim().slice(0, 120)
            : phone,
          source: 'WEBHOOK',
        },
        update: {},
      });
    }
    if (!contact) throw new NotFoundException('Contact not found for this flow');

    const variables: FlowVariables = {};
    if (body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables)) {
      for (const [key, value] of Object.entries(body.variables).slice(0, 40)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(key) || key.startsWith('__')) continue;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          variables[key] = String(value).slice(0, 1000);
        }
      }
    }

    return this.startTriggeredFlow(flow, contact, variables);
  }

  private async startTriggeredFlow(
    flow: { id: string; tenantId: string; businessId: string; name: string },
    contact: { id: string; name: string; phone: string },
    variables: FlowVariables,
    existingConversation?: any,
  ) {
    let conversation = existingConversation ?? await this.prisma.conversation.findFirst({
      where: { tenantId: flow.tenantId, businessId: flow.businessId, contactId: contact.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: {
          tenantId: flow.tenantId,
          businessId: flow.businessId,
          contactId: contact.id,
          isAiActive: false,
          status: 'OPEN',
        },
      });
    } else if (conversation.status === 'CLOSED') {
      conversation = await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: 'OPEN' },
      });
    }
    if (conversation.activeFlowId) {
      throw new ConflictException('This contact already has an active flow');
    }

    const creds = await this.resolveWACreds(
      conversation.businessId,
      conversation.whatsappIntegrationId ?? null,
    );
    const initialVariables: FlowVariables = {
      ...variables,
      contactId: contact.id,
      contactName: contact.name,
      contactPhone: contact.phone,
    };
    await this.executeFlow(
      flow.tenantId,
      flow.businessId,
      conversation,
      contact,
      '',
      null,
      creds,
      flow.id,
      initialVariables,
    );
    return { triggered: true, flowId: flow.id, conversationId: conversation.id };
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
    forcedFlowId?:     string,
    initialVariables:  FlowVariables = {},
  ): Promise<boolean> {
    if (!creds && !forcedFlowId) return false;

    let flowId: string | null = forcedFlowId ?? (conversation as any).activeFlowId ?? null;
    let fromNodeId: string | undefined = (conversation as any).activeNodeId ?? undefined;
    let vars: FlowVariables = ((conversation as any).flowVars as FlowVariables | null) ?? {};
    const isResuming = !forcedFlowId && Boolean(flowId && fromNodeId);

    if (!isResuming) {
      if (forcedFlowId) {
        fromNodeId = undefined;
        vars = initialVariables;
      } else {
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

        // Graded here rather than after the run, so the score is in the variables by the
        // time a condition node downstream asks about it. `force` because the author put
        // the node there deliberately — the usual every-N-messages throttle would make a
        // flow silently skip its own step.
        qualifyLead: async () => {
          const graded = await this.qualification.qualify(conversation.id, { force: true });
          return graded.score != null && graded.label
            ? { score: graded.score, label: graded.label }
            : null;
        },

        tagContact: async (node) => {
          const names = (node.tags ?? []).map((t) => t.trim()).filter(Boolean);
          if (!names.length) return;

          if (node.action === 'remove') {
            await this.prisma.contactTag.deleteMany({
              where: { contactId: contact.id, tag: { name: { in: names } } },
            });
            return;
          }

          for (const name of names) {
            // A tag the author typed may not exist yet; naming one in a flow is as good
            // as creating it.
            const tag = await this.prisma.tag.upsert({
              where:  { name_businessId: { name, businessId: conversation.businessId } },
              create: { name, businessId: conversation.businessId, tenantId: conversation.tenantId },
              update: {},
            });
            await this.prisma.contactTag.upsert({
              where:  { contactId_tagId: { contactId: contact.id, tagId: tag.id } },
              create: { contactId: contact.id, tagId: tag.id },
              update: {},
            });
          }
        },

        setLeadStage: async (node) => {
          const name = node.stageName?.trim();
          if (!name) return;
          const stage = await this.prisma.pipelineStage.findFirst({
            where:  { businessId: conversation.businessId, name: { equals: name, mode: 'insensitive' } },
            select: { id: true },
          });
          if (!stage) {
            this.logger.warn(`Flow stage "${name}" does not exist in business ${conversation.businessId}`);
            return;
          }
          const lead = await this.prisma.lead.findFirst({
            where:   { contactId: contact.id, businessId: conversation.businessId },
            orderBy: { createdAt: 'desc' },
            select:  { id: true },
          });
          if (!lead) return;
          await this.prisma.lead.update({ where: { id: lead.id }, data: { stageId: stage.id } });
        },

        notifyTeam: async (node, nodeVars) => {
          const who = contact.name || contact.phone;
          const render = (t?: string) =>
            (t ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k) => nodeVars[k] ?? '');

          let recipients: { roles: typeof MANAGER_ROLES } | { userIds: string[] };
          if (node.target === 'managers') {
            recipients = { roles: MANAGER_ROLES };
          } else {
            const userIds = node.target === 'department'
              ? await this.departmentMemberIds(conversation.businessId, node.departmentName)
              : conversation.assignedToId ? [conversation.assignedToId] : [];
            // Nobody to tell is not an error, but it is not a notification either.
            if (userIds.length === 0) return;
            recipients = { userIds };
          }

          await this.notifications.notify({
            tenantId:   conversation.tenantId,
            businessId: conversation.businessId,
            recipients,
            type:       'SYSTEM',
            title:      render(node.title) || `${who} needs attention`,
            body:       render(node.body) || null,
            href:       `/inbox?c=${conversation.id}`,
            data:       { conversationId: conversation.id, flowId: flow.id },
          });
        },
      },
    });

    // Send every outbound action to the customer and keep a copy in the thread.
    let sentCount = 0;
    for (const action of result.actions) {
      if (creds && action.type === 'menu' && action.menu) {
        try {
          const sent = await this.sendInteractive(creds, contact.phone, action.menu.interactive);
          await this.persistBotMessage(conversation, {
            type: 'INTERACTIVE', content: action.menu.text, waMessageId: sent?.messages?.[0]?.id ?? null,
            metadata: { interactive: action.menu.interactive, flowId: flow.id },
          });
          sentCount += 1;
        } catch {
          try {
            const sent = await this.sendText(creds, contact.phone, action.menu.text);
            await this.persistBotMessage(conversation, {
              type: 'TEXT', content: action.menu.text, waMessageId: sent?.messages?.[0]?.id ?? null,
              metadata: { flowId: flow.id },
            });
            sentCount += 1;
          } catch { /* skip */ }
        }
        continue;
      }
      if (creds && (action.type === 'message' || action.type === 'ai') && action.text) {
        try {
          const sent = await this.sendText(creds, contact.phone, action.text);
          await this.persistBotMessage(conversation, {
            type: 'TEXT', content: action.text, waMessageId: sent?.messages?.[0]?.id ?? null,
            metadata: { flowId: flow.id },
          });
          sentCount += 1;
        } catch { /* skip */ }
      }
    }

    // Persist / clear session state.
    if (creds && result.status === 'awaiting_input' && result.awaitingQuestionId) {
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

    // Handoff: the node's own department, team or note decides where it goes. These were
    // collected by the builder and then ignored; the handover service honours them.
    if (result.handoff) {
      const target = result.actions.find((a) => a.type === 'handoff')?.handoff;
      await this.handover.request({
        conversationId: conversation.id,
        reason:         'FLOW_NODE',
        note:           target?.note ?? null,
        departmentName: target?.department ?? target?.team ?? target?.queue ?? null,
      }).catch((err: any) => this.logger.error(`Flow handover failed for ${conversation.id}: ${err?.message ?? err}`));
      void this.events.conversationUpdated(conversation.id);
      void this.maybeQualify(conversation.id, 'ON_HANDOVER');
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

    await this.persistBotMessage(conversation, { type: 'TEXT', content: text, waMessageId });
  }

  /** Saves an automated outbound (AI or flow) into the thread and pushes it to agents. */
  private async persistBotMessage(
    conversation: { id: string; tenantId: string; businessId: string },
    msg: { type: 'TEXT' | 'INTERACTIVE'; content: string; waMessageId: string | null; metadata?: Record<string, unknown> },
  ): Promise<void> {
    const saved = await this.prisma.message.create({
      data: {
        tenantId:       conversation.tenantId,
        businessId:     conversation.businessId,
        conversationId: conversation.id,
        direction:      'OUTBOUND',
        status:         'SENT',
        type:           msg.type,
        content:        msg.content,
        waMessageId:    msg.waMessageId,
        metadata:       msg.metadata as any,
        isAiGenerated:  true,
        isNote:         false,
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data:  { lastMessageAt: new Date(), lastMessagePreview: msg.content.slice(0, 100) },
    });
    void this.events.messageNew(saved.id);
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
    // Provider selection, model rules and failure handling all live in LlmService, which
    // lead qualification uses as well. Keeping two copies meant the next provider change
    // had to be made twice.
    this.logger.log(`generateReply model=${model ?? 'default'} msgs=${history.length}`);
    return this.llm.complete(
      [{ role: 'system', content: systemPrompt }, ...history],
      { model, temperature, maxTokens },
    );
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

}
