import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { LlmService } from '../ai/llm.service';
import { MANAGER_ROLES, NotificationsService } from '../notifications/notifications.service';

/** The five things the model is asked to judge, and how much each is worth by default. */
export const DEFAULT_WEIGHTS = {
  budget:     25,
  authority:  20,
  need:       30,
  timeline:   15,
  engagement: 10,
} as const;

export type Criterion = keyof typeof DEFAULT_WEIGHTS;
export const CRITERIA = Object.keys(DEFAULT_WEIGHTS) as Criterion[];

/** What a weighted score is called. The bands are what the stage map keys off. */
export function scoreLabelFor(score: number): 'COLD' | 'WARM' | 'HOT' | 'QUALIFIED' {
  if (score >= 80) return 'QUALIFIED';
  if (score >= 65) return 'HOT';
  if (score >= 40) return 'WARM';
  return 'COLD';
}

export type QualificationTrigger = 'AFTER_MESSAGES' | 'ON_HANDOVER' | 'ON_CLOSE' | 'MANUAL';

/** What the model is asked to return. Every field is optional because models forget. */
interface ModelVerdict {
  isLead?: boolean;
  confidence?: number;
  scores?: Partial<Record<Criterion, number>>;
  budget?: string | null;
  authority?: string | null;
  requirement?: string | null;
  timeline?: string | null;
  companySize?: string | null;
  isDecisionMaker?: boolean;
  intent?: string | null;
  summary?: string | null;
  nextStep?: string | null;
  title?: string | null;
  value?: number | null;
}

export interface QualifyResult {
  status: 'created' | 'updated' | 'below_threshold' | 'not_a_lead' | 'skipped' | 'no_model' | 'no_config';
  leadId?: string;
  score?: number;
  label?: string;
  reason?: string;
}

const clamp = (n: unknown, lo = 0, hi = 100): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return Math.max(lo, Math.min(hi, Math.round(v)));
};

const text = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length ? s.slice(0, 2000) : null;
};

/**
 * Reads a conversation and decides whether it is a lead, how good a one, and why.
 *
 * The score is not the model's. The model rates five criteria out of 100 each, and the
 * weighted sum is computed here from the weights the business set. That matters for two
 * reasons: a business that does not care about budget can say so and have it reflected
 * immediately, without re-prompting, and the arithmetic is auditable — the breakdown is
 * stored, so any score can be taken apart afterwards.
 *
 * Fields an agent has already filled are never overwritten. Someone who corrects a budget
 * should not find the next run has undone it.
 */
@Injectable()
export class LeadQualificationService {
  private readonly logger = new Logger(LeadQualificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Settings ───────────────────────────────────────────────────────────────

  async configFor(businessId: string) {
    return this.prisma.leadQualificationConfig.findUnique({ where: { businessId } });
  }

  /** Weights normalised to sum to 100, so a score is always out of 100. */
  weightsFor(raw: unknown): Record<Criterion, number> {
    const given = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<Criterion, unknown>>;
    const picked = CRITERIA.map((k) => {
      const v = Number(given[k]);
      return Number.isFinite(v) && v >= 0 ? v : DEFAULT_WEIGHTS[k];
    });
    const total = picked.reduce((a, b) => a + b, 0);
    // All zeros would divide by zero and is never what anyone means.
    if (total <= 0) return { ...DEFAULT_WEIGHTS };
    return CRITERIA.reduce((acc, k, i) => {
      acc[k] = (picked[i] / total) * 100;
      return acc;
    }, {} as Record<Criterion, number>);
  }

  // ── Should this conversation be scored? ────────────────────────────────────

  /**
   * Whether a conversation is due for scoring under the business's own rules. Called on
   * every inbound message, so it does no model work and only the queries it needs.
   */
  async isDue(conversationId: string, trigger: QualificationTrigger): Promise<boolean> {
    const conversation = await this.prisma.conversation.findUnique({
      where:  { id: conversationId },
      select: { businessId: true, contactId: true },
    });
    if (!conversation) return false;

    const config = await this.configFor(conversation.businessId);
    if (!config?.enabled) return false;
    // A manual run is always allowed; otherwise the trigger has to match.
    if (trigger !== 'MANUAL' && config.trigger !== trigger) return false;

    if (trigger === 'AFTER_MESSAGES') {
      const inbound = await this.prisma.message.count({
        where: { conversationId, direction: 'INBOUND' },
      });
      if (inbound < Math.max(1, config.afterMessages)) return false;
    }

    // Already scored recently, and the business does not want it redone.
    const existing = await this.prisma.lead.findFirst({
      where:   { contactId: conversation.contactId, businessId: conversation.businessId },
      orderBy: { createdAt: 'desc' },
      select:  { aiQualifiedAt: true, closedAt: true },
    });
    if (existing?.aiQualifiedAt) {
      if (!config.requalify) return false;
      const waited = Date.now() - existing.aiQualifiedAt.getTime();
      if (waited < config.requalifyAfterHours * 60 * 60 * 1000) return false;
    }

    if (config.keywords.length) {
      const hit = await this.prisma.message.findFirst({
        where: {
          conversationId,
          direction: 'INBOUND',
          OR: config.keywords.map((k) => ({ content: { contains: k, mode: 'insensitive' as const } })),
        },
        select: { id: true },
      });
      if (!hit) return false;
    }

    return true;
  }

  // ── Scoring ────────────────────────────────────────────────────────────────

  async qualify(conversationId: string, opts: { force?: boolean; userId?: string } = {}): Promise<QualifyResult> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        contact: { select: { id: true, name: true, phone: true, company: true, email: true } },
      },
    });
    if (!conversation) return { status: 'skipped', reason: 'That conversation no longer exists.' };

    const config = await this.configFor(conversation.businessId);
    if (!config) return { status: 'no_config', reason: 'Lead qualification has not been set up for this workspace.' };
    if (!config.enabled && !opts.force) return { status: 'no_config', reason: 'Lead qualification is switched off.' };
    if (!this.llm.isConfigured()) return { status: 'no_model', reason: 'No AI provider is configured.' };

    const messages = await this.prisma.message.findMany({
      where:   { conversationId },
      orderBy: { createdAt: 'desc' },
      take:    40,
      select:  { direction: true, content: true, type: true, createdAt: true },
    });
    if (!messages.length) return { status: 'skipped', reason: 'There are no messages to read.' };

    const business = await this.prisma.business.findUnique({
      where:  { id: conversation.businessId },
      select: { name: true, aiModel: true },
    });

    const transcript = messages
      .reverse()
      .map((m) => {
        const body = m.content?.trim() || `[${m.type.toLowerCase()}]`;
        return `${m.direction === 'INBOUND' ? 'Customer' : 'Business'}: ${body}`;
      })
      .join('\n')
      .slice(0, 12_000);

    const verdict = await this.llm.completeJson<ModelVerdict>(
      [
        { role: 'system', content: this.systemPrompt(config, business?.name ?? null) },
        { role: 'user', content: `Conversation with ${conversation.contact.name || conversation.contact.phone}:\n\n${transcript}` },
      ],
      { model: config.model ?? business?.aiModel, maxTokens: 900, temperature: 0.1 },
    );

    if (!verdict) return { status: 'no_model', reason: 'The model did not return a usable answer.' };
    if (verdict.isLead === false && !opts.force) {
      return { status: 'not_a_lead', reason: verdict.summary ?? 'The model judged this not to be a sales enquiry.' };
    }

    // ── The arithmetic, done here rather than trusted to the model ──
    const weights = this.weightsFor(config.weights);
    const scores = CRITERIA.reduce((acc, k) => {
      acc[k] = clamp(verdict.scores?.[k]);
      return acc;
    }, {} as Record<Criterion, number>);
    const score = Math.round(
      CRITERIA.reduce((sum, k) => sum + (scores[k] * weights[k]) / 100, 0),
    );
    const label = scoreLabelFor(score);
    const confidence = clamp(verdict.confidence ?? 60);

    if (score < config.minScore && !opts.force) {
      return {
        status: 'below_threshold', score, label,
        reason: `Scored ${score}, under this workspace's minimum of ${config.minScore}.`,
      };
    }
    if (!config.autoCreate && !opts.force) {
      return { status: 'below_threshold', score, label, reason: 'Creating leads automatically is switched off.' };
    }

    const breakdown = {
      scores,
      weights,
      model: config.model ?? business?.aiModel ?? this.llm.defaultModel(),
      scoredAt: new Date().toISOString(),
    };

    const stageId = await this.stageFor(conversation.tenantId, config.stageMap, label);
    if (!stageId) {
      return { status: 'skipped', reason: 'This workspace has no pipeline stage to put a lead in.' };
    }

    const existing = await this.prisma.lead.findFirst({
      where:   { contactId: conversation.contactId, businessId: conversation.businessId, closedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    const aiFields = {
      qualifiedBy:      'AI',
      aiQualifiedAt:    new Date(),
      aiScore:          score,
      aiConfidence:     confidence,
      aiSummary:        text(verdict.summary),
      aiIntent:         text(verdict.intent),
      aiNextStep:       text(verdict.nextStep),
      aiModel:          breakdown.model,
      aiBreakdown:      breakdown as any,
      aiConversationId: conversationId,
      score,
      scoreLabel:       label,
    };

    if (existing) {
      // Only fill what a person has not already written.
      const lead = await this.prisma.lead.update({
        where: { id: existing.id },
        data: {
          ...aiFields,
          budget:          existing.budget      ?? text(verdict.budget),
          authority:       existing.authority   ?? text(verdict.authority),
          requirement:     existing.requirement ?? text(verdict.requirement),
          timeline:        existing.timeline    ?? text(verdict.timeline),
          companySize:     existing.companySize ?? text(verdict.companySize),
          isDecisionMaker: existing.isDecisionMaker || Boolean(verdict.isDecisionMaker),
          value:           existing.value       ?? (typeof verdict.value === 'number' ? verdict.value : null),
          ...(config.autoAssign && !existing.assignedToId && conversation.assignedToId
            ? { assignedToId: conversation.assignedToId }
            : {}),
        },
      });
      await this.recordActivity(lead.id, opts.userId, score, label, confidence, verdict, breakdown);
      await this.announce(conversation, config, lead.id, score, label);
      return { status: 'updated', leadId: lead.id, score, label };
    }

    const lead = await this.prisma.lead.create({
      data: {
        tenantId:   conversation.tenantId,
        businessId: conversation.businessId,
        contactId:  conversation.contactId,
        title:      text(verdict.title) ?? `Enquiry from ${conversation.contact.name || conversation.contact.phone}`,
        stageId,
        ...aiFields,
        budget:          text(verdict.budget),
        authority:       text(verdict.authority),
        requirement:     text(verdict.requirement),
        timeline:        text(verdict.timeline),
        companySize:     text(verdict.companySize),
        isDecisionMaker: Boolean(verdict.isDecisionMaker),
        value:           typeof verdict.value === 'number' ? verdict.value : null,
        ...(config.autoAssign && conversation.assignedToId ? { assignedToId: conversation.assignedToId } : {}),
      },
    });

    await this.recordActivity(lead.id, opts.userId, score, label, confidence, verdict, breakdown);
    await this.announce(conversation, config, lead.id, score, label);
    this.logger.log(`Qualified ${conversationId} as lead ${lead.id}: ${score} (${label})`);
    return { status: 'created', leadId: lead.id, score, label };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private systemPrompt(
    config: { instructions: string | null; productContext: string | null },
    businessName: string | null,
  ): string {
    return [
      `You read a WhatsApp conversation and judge whether the customer is a sales lead${businessName ? ` for ${businessName}` : ''}.`,
      config.productContext ? `\nWhat this business sells:\n${config.productContext}` : '',
      config.instructions ? `\nWhat this business counts as a good lead:\n${config.instructions}` : '',
      `
Rate each of these out of 100, judging only from what the conversation actually shows:
- budget: signs they can pay, or have said what they can spend
- authority: signs they can decide, or speak for whoever does
- need: how clear and real their requirement is
- timeline: how soon they want it
- engagement: how responsive and interested they are

Score 0 for anything the conversation gives no evidence of. Do not invent figures,
companies or dates. Leave a field null rather than guessing it.

Reply with JSON only, no prose and no code fence, in exactly this shape:
{
  "isLead": boolean,
  "confidence": 0-100,
  "scores": { "budget": 0-100, "authority": 0-100, "need": 0-100, "timeline": 0-100, "engagement": 0-100 },
  "title": "short name for this opportunity",
  "budget": string or null,
  "authority": string or null,
  "requirement": string or null,
  "timeline": string or null,
  "companySize": string or null,
  "isDecisionMaker": boolean,
  "value": number or null,
  "intent": "what they want, in one line",
  "summary": "two or three sentences a salesperson can act on",
  "nextStep": "the single next thing the business should do"
}`,
    ].filter(Boolean).join('\n');
  }

  /** The stage a score band belongs in, falling back to the pipeline's default. */
  private async stageFor(tenantId: string, stageMap: unknown, label: string): Promise<string | null> {
    const map = (stageMap && typeof stageMap === 'object' ? stageMap : {}) as Record<string, unknown>;
    const mapped = map[label.toLowerCase()];
    if (typeof mapped === 'string' && mapped) {
      const exists = await this.prisma.pipelineStage.findFirst({
        where: { id: mapped, tenantId }, select: { id: true },
      });
      if (exists) return exists.id;
    }
    const fallback = await this.prisma.pipelineStage.findFirst({
      where:   { tenantId, enabled: true },
      orderBy: [{ isDefault: 'desc' }, { order: 'asc' }],
      select:  { id: true },
    });
    return fallback?.id ?? null;
  }

  private async recordActivity(
    leadId: string, userId: string | undefined,
    score: number, label: string, confidence: number,
    verdict: ModelVerdict, breakdown: unknown,
  ): Promise<void> {
    await this.prisma.leadActivity.create({
      data: {
        leadId,
        userId: userId ?? null,
        type:   'AI_QUALIFICATION',
        content: [
          `Scored ${score} out of 100 (${label}), confidence ${confidence}%.`,
          verdict.summary?.trim(),
          verdict.nextStep?.trim() ? `Next step: ${verdict.nextStep.trim()}` : null,
        ].filter(Boolean).join(' '),
        metadata: breakdown as any,
      },
    }).catch((err) => this.logger.warn(`Could not record the qualification activity: ${err.message}`));
  }

  private async announce(
    conversation: { tenantId: string; businessId: string; assignedToId: string | null; contact: { name: string; phone: string } },
    config: { notifyAboveScore: number },
    leadId: string, score: number, label: string,
  ): Promise<void> {
    if (!config.notifyAboveScore || score < config.notifyAboveScore) return;
    const who = conversation.contact.name || conversation.contact.phone;
    void this.notifications.notify({
      tenantId:   conversation.tenantId,
      businessId: conversation.businessId,
      // The agent on the thread if there is one, otherwise whoever manages the pipeline.
      recipients: conversation.assignedToId ? { userIds: [conversation.assignedToId] } : { roles: MANAGER_ROLES },
      type:       'LEAD_QUALIFIED',
      title:      `${label.toLowerCase() === 'qualified' ? 'Qualified' : label} lead: ${who}`,
      body:       `Scored ${score} out of 100 from their conversation.`,
      href:       `/leads?leadId=${leadId}`,
      data:       { leadId, score, label },
    });
  }
}
