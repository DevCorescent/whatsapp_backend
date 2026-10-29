import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { MANAGER_ROLES, NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { LlmService } from '../ai/llm.service';

export type HandoverReason =
  | 'CUSTOMER_REQUEST'
  | 'FLOW_NODE'
  | 'AI_UNSURE'
  | 'AFTER_REPLIES'
  | 'NEGATIVE_SENTIMENT'
  | 'OFF_HOURS'
  | 'MANUAL';

export const HANDOVER_REASON_LABELS: Record<HandoverReason, string> = {
  CUSTOMER_REQUEST:   'They asked for a person',
  FLOW_NODE:          'The flow handed it over',
  AI_UNSURE:          'The AI was unsure',
  AFTER_REPLIES:      'Too many AI replies in a row',
  NEGATIVE_SENTIMENT: 'They sounded unhappy',
  OFF_HOURS:          'Outside business hours',
  MANUAL:             'Handed over by a colleague',
};

/** The phrasings that count as asking for a person when a business sets none of its own. */
export const DEFAULT_REQUEST_KEYWORDS = [
  'human', 'agent', 'person', 'representative', 'real person', 'customer care',
  'customer service', 'speak to someone', 'talk to someone', 'support team',
  'executive', 'manager', 'operator',
];

/**
 * Which of these phrasings a message uses to ask for a person, or null.
 *
 * Matched on word boundaries with an optional plural, so "do you have agents" counts
 * while "humanity" and "management fees" do not. A substring match would turn both of
 * those into handovers nobody asked for.
 */
export function matchesHumanRequest(message: string, keywords: string[]): string | null {
  const body = message.toLowerCase();
  for (const keyword of keywords) {
    const needle = keyword.toLowerCase().trim();
    if (!needle) continue;
    const pattern = new RegExp(`(^|[^a-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?([^a-z]|$)`);
    if (pattern.test(body)) return keyword;
  }
  return null;
}

export interface HandoverInput {
  conversationId: string;
  reason: HandoverReason;
  /** Why, in words — from a flow node or the colleague who did it. */
  note?: string | null;
  /** The customer's own message that set it off, for context on the queue. */
  trigger?: string | null;
  /** Overrides the configured routing, used by a flow node naming a department. */
  departmentName?: string | null;
  departmentId?: string | null;
  assignToId?: string | null;
  /** Who did it, when a person did. */
  byUserId?: string | null;
}

export interface HandoverOutcome {
  handoverId: string;
  assignedToId: string | null;
  departmentId: string | null;
  status: 'ASSIGNED' | 'PENDING';
}

/**
 * Passing a conversation from the AI to a person.
 *
 * Before this, a flow's handoff node turned the AI off and picked whichever agent had the
 * fewest open threads. That is one of four reasonable policies, it ignored the team and
 * department the node collected, and it left no record — so nobody could see what had
 * been handed over, by what, or whether anyone picked it up. Each handover is now a row
 * with a reason and a status, which is what the queue screen reads.
 */
@Injectable()
export class HandoverService {
  private readonly logger = new Logger(HandoverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
    private readonly llm: LlmService,
  ) {}

  // ── Settings ───────────────────────────────────────────────────────────────

  async configFor(businessId: string) {
    return this.prisma.handoverConfig.findUnique({ where: { businessId } });
  }

  /** The words that mean "get me a person" for this business. */
  requestKeywords(config: { requestKeywords: string[] } | null): string[] {
    return config?.requestKeywords.length ? config.requestKeywords : DEFAULT_REQUEST_KEYWORDS;
  }

  /** Whether this message asks for a person, under the words this business uses. */
  asksForHuman(message: string, config: { requestKeywords: string[] } | null): string | null {
    return matchesHumanRequest(message, this.requestKeywords(config));
  }

  /**
   * What the model makes of one customer message: whether it needs a person, how sure it
   * is that it could answer, and how the customer sounds.
   *
   * One extra model call per inbound message, which is why it only runs when a business
   * has switched on a trigger that needs it. Returns null when the model is unavailable
   * or unparseable, and the caller treats that as "no opinion" rather than handing over.
   */
  async assess(message: string): Promise<{ needsHuman: boolean; confidence: number; sentiment: string } | null> {
    if (!message.trim() || !this.llm.isConfigured()) return null;

    const verdict = await this.llm.completeJson<{
      needsHuman?: boolean; confidence?: number; sentiment?: string;
    }>([
      {
        role: 'system',
        content: `You triage one customer message for a WhatsApp support queue.

Reply with JSON only, no prose:
{
  "needsHuman": true if this plainly needs a person — a complaint, a refund, a legal or
                safety matter, an account-specific problem, or an explicit request for one,
  "confidence": 0-100, how confident an automated assistant could answer it well,
  "sentiment": "positive", "neutral" or "negative"
}`,
      },
      { role: 'user', content: message.slice(0, 2000) },
    ], { maxTokens: 120, temperature: 0 });

    if (!verdict) return null;
    const confidence = Number(verdict.confidence);
    return {
      needsHuman: verdict.needsHuman === true,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence))) : 100,
      sentiment:  ['positive', 'neutral', 'negative'].includes(String(verdict.sentiment))
        ? String(verdict.sentiment) : 'neutral',
    };
  }

  // ── Handing over ───────────────────────────────────────────────────────────

  async request(input: HandoverInput): Promise<HandoverOutcome | null> {
    const conversation = await this.prisma.conversation.findUnique({
      where:  { id: input.conversationId },
      select: {
        id: true, tenantId: true, businessId: true, contactId: true, assignedToId: true,
        contact: { select: { name: true, phone: true } },
      },
    });
    if (!conversation) return null;

    const config = await this.configFor(conversation.businessId);
    // An explicit handover still works with the feature switched off: a person asking for
    // a colleague, or a flow built to hand over, is not something a setting should block.
    const explicit = input.reason === 'MANUAL' || input.reason === 'FLOW_NODE';
    if (config && !config.enabled && !explicit) return null;

    const departmentId = await this.resolveDepartment(conversation.businessId, input, config);
    const assignedToId = await this.resolveAssignee(conversation, input, config, departmentId);

    const handover = await this.prisma.handoverRequest.create({
      data: {
        tenantId:       conversation.tenantId,
        businessId:     conversation.businessId,
        conversationId: conversation.id,
        contactId:      conversation.contactId,
        reason:         input.reason,
        note:           input.note?.slice(0, 1000) ?? null,
        trigger:        input.trigger?.slice(0, 500) ?? null,
        departmentId,
        assignedToId,
        status:         assignedToId ? 'ASSIGNED' : 'PENDING',
        assignedAt:     assignedToId ? new Date() : null,
      },
    });

    // The conversation itself: stop the AI, and give it an owner.
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        ...(config?.pauseAi !== false ? { isAiActive: false } : {}),
        ...(assignedToId ? { assignedToId, status: 'ASSIGNED' as const } : {}),
      },
    });

    const who = conversation.contact.name || conversation.contact.phone;
    const reasonLabel = HANDOVER_REASON_LABELS[input.reason] ?? 'Handed over';

    if (config?.notifyAgent !== false && assignedToId) {
      void this.notifications.notify({
        tenantId:   conversation.tenantId,
        businessId: conversation.businessId,
        recipients: { userIds: [assignedToId] },
        type:       'HANDOVER_REQUESTED',
        title:      `${who} needs a person`,
        body:       input.note?.trim() || reasonLabel,
        href:       `/inbox?conversationId=${conversation.id}`,
        data:       { conversationId: conversation.id, handoverId: handover.id, reason: input.reason },
      });
    }

    // Nobody to give it to is worth telling a manager about, whatever the settings say:
    // the thread is now waiting on a human who does not exist yet.
    if (config?.notifyManagers || !assignedToId) {
      void this.notifications.notify({
        tenantId:   conversation.tenantId,
        businessId: conversation.businessId,
        recipients: { roles: MANAGER_ROLES },
        type:       'HANDOVER_REQUESTED',
        title:      assignedToId ? `${who} handed to a colleague` : `${who} is waiting for a person`,
        body:       assignedToId ? reasonLabel : `${reasonLabel}, and nobody was free to take it.`,
        href:       assignedToId ? `/inbox?conversationId=${conversation.id}` : '/handovers',
        data:       { conversationId: conversation.id, handoverId: handover.id, reason: input.reason },
      });
    }

    this.realtime.toBusiness(conversation.businessId, 'handover:new', {
      id:             handover.id,
      conversationId: conversation.id,
      contactName:    who,
      reason:         input.reason,
      status:         handover.status,
      assignedToId,
      departmentId,
      requestedAt:    handover.requestedAt.toISOString(),
    });

    this.logger.log(
      `Handover ${handover.id} for ${conversation.id}: ${input.reason} → ${assignedToId ?? 'nobody'}`,
    );
    return { handoverId: handover.id, assignedToId, departmentId, status: handover.status as 'ASSIGNED' | 'PENDING' };
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  /** A named department from a flow beats the configured one, which beats the default. */
  private async resolveDepartment(
    businessId: string,
    input: HandoverInput,
    config: { strategy: string; departmentId: string | null } | null,
  ): Promise<string | null> {
    if (input.departmentId) {
      const byId = await this.prisma.department.findFirst({
        where: { id: input.departmentId, businessId }, select: { id: true },
      });
      if (byId) return byId.id;
    }
    if (input.departmentName?.trim()) {
      const byName = await this.prisma.department.findFirst({
        where:  { businessId, name: { equals: input.departmentName.trim(), mode: 'insensitive' } },
        select: { id: true },
      });
      if (byName) return byName.id;
      this.logger.warn(`No department called "${input.departmentName}" in business ${businessId}`);
    }
    if (config?.strategy === 'DEPARTMENT' && config.departmentId) return config.departmentId;

    const fallback = await this.prisma.department.findFirst({
      where:  { businessId, enabled: true, isDefault: true },
      select: { id: true },
    });
    return fallback?.id ?? null;
  }

  /**
   * Who should own the thread.
   *
   * A department narrows the pool to its members; the strategy then picks from the pool.
   * A pool that comes back empty falls back to the whole workspace rather than leaving the
   * customer with nobody, and only a workspace with no agents at all yields null.
   */
  private async resolveAssignee(
    conversation: { tenantId: string; businessId: string; assignedToId: string | null },
    input: HandoverInput,
    config: { strategy: string; assignToId: string | null; onlineOnly: boolean } | null,
    departmentId: string | null,
  ): Promise<string | null> {
    // Already owned by a person: leave it with them.
    if (conversation.assignedToId) return conversation.assignedToId;

    const strategy = input.assignToId ? 'SPECIFIC_USER' : (config?.strategy ?? 'LEAST_BUSY');
    const wanted = input.assignToId ?? config?.assignToId ?? null;

    if (strategy === 'SPECIFIC_USER' && wanted) {
      const target = await this.prisma.user.findFirst({
        where:  { id: wanted, tenantId: conversation.tenantId, isActive: true, removedAt: null },
        select: { id: true },
      });
      if (target) return target.id;
      this.logger.warn(`Handover target ${wanted} is not an active member; falling back to least busy`);
    }

    let pool = departmentId ? await this.departmentMembers(departmentId, conversation.tenantId) : [];
    if (!pool.length) pool = await this.workspaceAgents(conversation.tenantId);
    if (!pool.length) return null;

    if (config?.onlineOnly) {
      const online = await this.realtime.onlineUsersInBusiness(conversation.businessId);
      const connected = pool.filter((id) => online.has(id));
      // Everyone being offline is not a reason to drop the thread on the floor.
      if (connected.length) pool = connected;
    }

    if (strategy === 'ROUND_ROBIN') return this.nextInRotation(conversation.businessId, pool);
    return this.leastBusy(pool);
  }

  private async departmentMembers(departmentId: string, tenantId: string): Promise<string[]> {
    const members = await this.prisma.departmentMember.findMany({
      where:  { departmentId, user: { tenantId, isActive: true, removedAt: null } },
      select: { userId: true },
    });
    return members.map((m) => m.userId);
  }

  private async workspaceAgents(tenantId: string): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where:  { tenantId, isActive: true, removedAt: null, role: { in: ['AGENT', 'MANAGER', 'ADMIN', 'TENANT_OWNER'] } },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /** Whoever in the pool has the fewest conversations open right now. */
  private async leastBusy(pool: string[]): Promise<string> {
    const counts = await this.prisma.conversation.groupBy({
      by:     ['assignedToId'],
      where:  { assignedToId: { in: pool }, status: { in: ['OPEN', 'ASSIGNED'] } },
      _count: { _all: true },
    });
    const load = new Map(counts.map((c) => [c.assignedToId!, c._count._all]));
    // Ties break on id so the choice is stable rather than depending on row order.
    return [...pool].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || a.localeCompare(b))[0];
  }

  /**
   * The next person after whoever took the last one.
   *
   * Derived from the most recent handover rather than a stored cursor, so it needs no
   * extra state and self-corrects when the pool changes.
   */
  private async nextInRotation(businessId: string, pool: string[]): Promise<string> {
    const last = await this.prisma.handoverRequest.findFirst({
      where:   { businessId, assignedToId: { in: pool } },
      orderBy: { requestedAt: 'desc' },
      select:  { assignedToId: true },
    });
    const ordered = [...pool].sort();
    if (!last?.assignedToId) return ordered[0];
    const at = ordered.indexOf(last.assignedToId);
    return ordered[(at + 1) % ordered.length];
  }

  // ── The queue ──────────────────────────────────────────────────────────────

  async list(
    scope: { tenantId: string; businessId: string },
    query: {
      status?: string; reason?: string; departmentId?: string; assignedToId?: string;
      page?: number; limit?: number;
    } = {},
  ) {
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 25);

    const where: Record<string, unknown> = { tenantId: scope.tenantId, businessId: scope.businessId };
    if (query.status && query.status !== 'ALL') where.status = query.status;
    if (query.reason) where.reason = query.reason;
    if (query.departmentId) where.departmentId = query.departmentId;
    if (query.assignedToId) where.assignedToId = query.assignedToId;

    const [requests, total, waiting] = await Promise.all([
      this.prisma.handoverRequest.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ status: 'asc' }, { requestedAt: 'desc' }],
        include: {
          department:   { select: { id: true, name: true, color: true } },
          assignedTo:   { select: { id: true, name: true } },
          conversation: {
            select: { id: true, status: true, lastMessageAt: true, contact: { select: { name: true, phone: true } } },
          },
        },
      }),
      this.prisma.handoverRequest.count({ where }),
      this.prisma.handoverRequest.count({
        where: { tenantId: scope.tenantId, businessId: scope.businessId, status: { in: ['PENDING', 'ASSIGNED'] } },
      }),
    ]);

    return { requests, total, page, limit, waiting };
  }

  /** Taking it on: the thread becomes theirs and the clock stops. */
  async accept(scope: { tenantId: string; businessId: string; userId: string }, id: string) {
    const handover = await this.prisma.handoverRequest.findFirst({
      where: { id, tenantId: scope.tenantId, businessId: scope.businessId },
    });
    if (!handover) return null;

    const updated = await this.prisma.handoverRequest.update({
      where: { id },
      data:  { status: 'ACCEPTED', acceptedAt: new Date(), assignedToId: scope.userId, assignedAt: handover.assignedAt ?? new Date() },
    });
    await this.prisma.conversation.update({
      where: { id: handover.conversationId },
      data:  { assignedToId: scope.userId, status: 'ASSIGNED', isAiActive: false },
    });
    this.realtime.toBusiness(scope.businessId, 'handover:update', {
      id, status: 'ACCEPTED', assignedToId: scope.userId,
    });
    return updated;
  }

  async resolve(scope: { tenantId: string; businessId: string }, id: string) {
    const updated = await this.prisma.handoverRequest.updateMany({
      where: { id, tenantId: scope.tenantId, businessId: scope.businessId },
      data:  { status: 'RESOLVED', resolvedAt: new Date() },
    });
    if (!updated.count) return null;
    this.realtime.toBusiness(scope.businessId, 'handover:update', { id, status: 'RESOLVED', assignedToId: null });
    return { resolved: true };
  }

  /** Give it back to the AI. */
  async cancel(scope: { tenantId: string; businessId: string }, id: string) {
    const handover = await this.prisma.handoverRequest.findFirst({
      where:  { id, tenantId: scope.tenantId, businessId: scope.businessId },
      select: { conversationId: true },
    });
    if (!handover) return null;

    await this.prisma.handoverRequest.update({
      where: { id },
      data:  { status: 'CANCELLED', resolvedAt: new Date() },
    });
    await this.prisma.conversation.update({
      where: { id: handover.conversationId },
      data:  { isAiActive: true },
    });
    this.realtime.toBusiness(scope.businessId, 'handover:update', { id, status: 'CANCELLED', assignedToId: null });
    return { cancelled: true };
  }

  /** Still waiting, for the badge on the nav. */
  async waitingCount(scope: { tenantId: string; businessId: string }): Promise<number> {
    return this.prisma.handoverRequest.count({
      where: { tenantId: scope.tenantId, businessId: scope.businessId, status: { in: ['PENDING', 'ASSIGNED'] } },
    });
  }

  /** Close any open handover on a conversation, called when the thread is closed. */
  async resolveForConversation(conversationId: string): Promise<void> {
    await this.prisma.handoverRequest.updateMany({
      where: { conversationId, status: { in: ['PENDING', 'ASSIGNED', 'ACCEPTED'] } },
      data:  { status: 'RESOLVED', resolvedAt: new Date() },
    }).catch(() => {});
  }
}
