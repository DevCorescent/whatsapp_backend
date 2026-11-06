import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { InboundPipelineService } from '../../../../apps/messaging/src/webhook/inbound-pipeline.service';
import {
  TenantScope, LeadQualificationService, CRITERIA, DEFAULT_WEIGHTS, scoreLabelFor,
  normalizePhone,
} from '@lib/common';
import {
  buildLeadWhere, leadOrderBy, leadsToCsv,
  DEFAULT_LEAD_COLUMNS, LEAD_COLUMNS, LEAD_SORTS,
  type LeadFilterQuery, type LeadRow,
} from './lead-filters';

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly qualification: LeadQualificationService,
    private readonly flowPipeline: InboundPipelineService,
  ) {}

  // ── Pipeline Stages ─────────────────────────────────────────────────────────

  async listStages(scope: TenantScope) {
    return this.prisma.pipelineStage.findMany({
      where:   { tenantId: scope.tenantId },
      orderBy: { order: 'asc' },
    });
  }

  async bulkUpdateStages(
    scope: TenantScope,
    body: {
      stages: Array<{
        id?: string; name: string; color?: string; order: number;
        enabled?: boolean; outcome?: string; isDefault?: boolean;
      }>;
    },
  ) {
    await this.prisma.$transaction(
      body.stages.map((s) =>
        s.id
          ? this.prisma.pipelineStage.update({
              where: { id: s.id },
              data: {
                name:      s.name,
                color:     s.color,
                order:     s.order,
                enabled:   s.enabled,
                outcome:   s.outcome as any,
                isDefault: s.isDefault,
              },
            })
          : this.prisma.pipelineStage.create({
              data: {
                tenantId:  scope.tenantId,
                name:      s.name,
                color:     s.color     ?? 'slate',
                order:     s.order,
                enabled:   s.enabled   ?? true,
                outcome:   (s.outcome  ?? 'OPEN') as any,
                isDefault: s.isDefault ?? false,
              },
            }),
      ),
    );
    return this.listStages(scope);
  }

  // ── Leads ──────────────────────────────────────────────────────────────────

  async listLeads(
    scope: TenantScope,
    query: LeadFilterQuery & { page?: number; limit?: number },
  ) {
    const page  = Math.max(1, query.page  ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const where = buildLeadWhere(scope, query);

    const [leads, total, stats] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        skip:    (page - 1) * limit,
        take:    limit,
        orderBy: leadOrderBy(query.sort),
        include: {
          contact:    { select: { name: true, phone: true, company: true } },
          assignedTo: { select: { name: true } },
          stage:      { select: { name: true, color: true, outcome: true } },
          _count:     { select: { activities: true } },
        },
      }),
      this.prisma.lead.count({ where }),
      // Totals for the matched set, not the page — a filtered list is worth a figure.
      this.prisma.lead.aggregate({
        where,
        _sum: { value: true },
        _avg: { score: true },
      }),
    ]);

    return {
      leads, total, page, limit,
      totals: {
        value:    stats._sum.value ?? 0,
        avgScore: Math.round(stats._avg.score ?? 0),
      },
    };
  }

  /**
   * What the list can be narrowed by, filled in with this workspace's own stages, people
   * and tags, so the filter panel never has to guess.
   */
  async filterOptions(scope: TenantScope) {
    const [stages, agents, tags] = await Promise.all([
      this.prisma.pipelineStage.findMany({
        where:   { tenantId: scope.tenantId, enabled: true },
        orderBy: { order: 'asc' },
        select:  { id: true, name: true, color: true, outcome: true },
      }),
      this.prisma.user.findMany({
        where:   { tenantId: scope.tenantId, isActive: true, removedAt: null },
        orderBy: { name: 'asc' },
        select:  { id: true, name: true, role: true },
      }),
      this.prisma.tag.findMany({
        where:   { businessId: scope.businessId },
        orderBy: { name: 'asc' },
        select:  { name: true, color: true },
      }),
    ]);

    return {
      stages, agents, tags,
      scoreLabels:  ['COLD', 'WARM', 'HOT', 'QUALIFIED'],
      qualifiedBy:  ['AI', 'MANUAL', 'IMPORT', 'API'],
      outcomes:     ['OPEN', 'WON', 'LOST'],
      sorts: Object.keys(LEAD_SORTS),
      columns: LEAD_COLUMNS.map((c) => ({ key: c.key, label: c.label })),
      defaultColumns: DEFAULT_LEAD_COLUMNS,
    };
  }

  /** The same filters, as a CSV. */
  async exportLeads(scope: TenantScope, query: LeadFilterQuery & { columns?: string; limit?: number }) {
    const where = buildLeadWhere(scope, query);
    const leads = await this.prisma.lead.findMany({
      where,
      orderBy: leadOrderBy(query.sort),
      // A hard ceiling: an export is a file somebody downloads, not a data dump.
      take: Math.min(query.limit ?? 10_000, 10_000),
      include: {
        contact:    { select: { name: true, phone: true, email: true, company: true, source: true, tags: { include: { tag: { select: { name: true } } } } } },
        assignedTo: { select: { name: true, email: true } },
        stage:      { select: { name: true, outcome: true } },
      },
    });

    const columns = (query.columns ?? '').split(',').map((c) => c.trim()).filter(Boolean);
    return { csv: leadsToCsv(leads as unknown as LeadRow[], columns), count: leads.length };
  }

  // ── AI qualification settings ──────────────────────────────────────────────

  async getQualificationConfig(scope: TenantScope) {
    const [config, stages] = await Promise.all([
      this.prisma.leadQualificationConfig.findUnique({ where: { businessId: scope.businessId } }),
      this.prisma.pipelineStage.findMany({
        where:   { tenantId: scope.tenantId, enabled: true },
        orderBy: { order: 'asc' },
        select:  { id: true, name: true, color: true },
      }),
    ]);

    return {
      config: config ?? {
        enabled: false, trigger: 'AFTER_MESSAGES', afterMessages: 6,
        requalify: true, requalifyAfterHours: 24, keywords: [],
        minScore: 0, autoCreate: true, autoAssign: true,
        instructions: null, productContext: null, weights: null, stageMap: null,
        model: null, notifyAboveScore: 0,
      },
      stages,
      defaultWeights: DEFAULT_WEIGHTS,
      criteria: CRITERIA,
      triggers: ['AFTER_MESSAGES', 'ON_HANDOVER', 'ON_CLOSE', 'MANUAL'],
      bands: [
        { label: 'QUALIFIED', from: 80 },
        { label: 'HOT',       from: 65 },
        { label: 'WARM',      from: 40 },
        { label: 'COLD',      from: 0 },
      ],
    };
  }

  async saveQualificationConfig(scope: TenantScope, body: Record<string, unknown>) {
    const int = (v: unknown, lo: number, hi: number, fallback: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
    };
    const str = (v: unknown, max: number) =>
      typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

    const triggers = ['AFTER_MESSAGES', 'ON_HANDOVER', 'ON_CLOSE', 'MANUAL'];

    // Weights are stored as given and normalised when a score is computed, so a set that
    // does not add to 100 is still meaningful rather than being rejected.
    let weights: Record<string, number> | null = null;
    if (body.weights && typeof body.weights === 'object') {
      weights = {};
      for (const key of CRITERIA) {
        weights[key] = int((body.weights as Record<string, unknown>)[key], 0, 100, DEFAULT_WEIGHTS[key]);
      }
    }

    // Only real stages, so a renamed or deleted one cannot strand a score band.
    let stageMap: Record<string, string> | null = null;
    if (body.stageMap && typeof body.stageMap === 'object') {
      const valid = await this.prisma.pipelineStage.findMany({
        where: { tenantId: scope.tenantId }, select: { id: true },
      });
      const ids = new Set(valid.map((s) => s.id));
      stageMap = {};
      for (const band of ['qualified', 'hot', 'warm', 'cold']) {
        const id = (body.stageMap as Record<string, unknown>)[band];
        if (typeof id === 'string' && ids.has(id)) stageMap[band] = id;
      }
    }

    const keywords = Array.isArray(body.keywords)
      ? [...new Set((body.keywords as unknown[]).map((k) => String(k).trim()).filter((k) => k.length >= 2 && k.length <= 60))].slice(0, 50)
      : undefined;

    const data = {
      enabled:             body.enabled === true,
      trigger:             triggers.includes(String(body.trigger)) ? String(body.trigger) : 'AFTER_MESSAGES',
      afterMessages:       int(body.afterMessages, 1, 100, 6),
      requalify:           body.requalify !== false,
      requalifyAfterHours: int(body.requalifyAfterHours, 1, 720, 24),
      minScore:            int(body.minScore, 0, 100, 0),
      autoCreate:          body.autoCreate !== false,
      autoAssign:          body.autoAssign !== false,
      instructions:        str(body.instructions, 4000),
      productContext:      str(body.productContext, 4000),
      model:               str(body.model, 200),
      notifyAboveScore:    int(body.notifyAboveScore, 0, 100, 0),
      ...(weights  ? { weights:  weights as any }  : {}),
      ...(stageMap ? { stageMap: stageMap as any } : {}),
      ...(keywords ? { keywords } : {}),
    };

    return this.prisma.leadQualificationConfig.upsert({
      where:  { businessId: scope.businessId },
      create: { tenantId: scope.tenantId, businessId: scope.businessId, ...data, keywords: keywords ?? [] },
      update: data,
    });
  }

  /** Score one conversation now, whatever the configured trigger says. */
  async qualifyConversation(scope: TenantScope, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where:  { id: conversationId, tenantId: scope.tenantId, businessId: scope.businessId },
      select: { id: true },
    });
    if (!conversation) throw new NotFoundException('That conversation does not exist here');
    return this.qualification.qualify(conversationId, { force: true, userId: scope.userId });
  }

  async createLead(
    scope: TenantScope,
    body: {
      contactId: string; title: string; stageId: string;
      value?: number; currency?: string; budget?: string;
      authority?: string; requirement?: string; timeline?: string;
      companySize?: string; isDecisionMaker?: boolean;
      assignedToId?: string; notes?: string;
    },
  ) {
    const stage = await this.prisma.pipelineStage.findFirst({
      where: { id: body.stageId, tenantId: scope.tenantId },
    });
    if (!stage) throw new BadRequestException('Stage not found or does not belong to tenant');

    const score = 0;
    const lead = await this.prisma.lead.create({
      data: {
        tenantId:        scope.tenantId,
        businessId:      scope.businessId,
        contactId:       body.contactId,
        title:           body.title,
        stageId:         body.stageId,
        score,
        scoreLabel:      scoreLabelFor(score) as any,
        value:           body.value,
        currency:        body.currency,
        budget:          body.budget,
        authority:       body.authority,
        requirement:     body.requirement,
        timeline:        body.timeline,
        companySize:     body.companySize,
        isDecisionMaker: body.isDecisionMaker ?? false,
        assignedToId:    body.assignedToId,
        notes:           body.notes,
      },
    });
    this.dispatchFlowTrigger(scope, lead.contactId, 'LEAD_CREATED', {
      leadId: lead.id,
      leadTitle: lead.title,
      leadStage: stage.name,
    });
    return lead;
  }

  async getLead(scope: TenantScope, id: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, tenantId: scope.tenantId, businessId: scope.businessId },
      include: {
        contact:    true,
        stage:      true,
        assignedTo: { select: { id: true, name: true } },
        activities: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  async updateLead(
    scope: TenantScope,
    id: string,
    body: {
      title?: string; stageId?: string; value?: number; assignedToId?: string;
      score?: number; scoreLabel?: string; budget?: string; authority?: string;
      requirement?: string; timeline?: string; notes?: string; lostReason?: string;
    },
  ) {
    const lead = await this.getLead(scope, id);

    const data: any = {};
    let nextStageName: string | undefined;
    let closesLead = false;
    if (body.title        !== undefined) data.title        = body.title;
    if (body.value        !== undefined) data.value        = body.value;
    if (body.assignedToId !== undefined) data.assignedToId = body.assignedToId;
    if (body.budget       !== undefined) data.budget       = body.budget;
    if (body.authority    !== undefined) data.authority    = body.authority;
    if (body.requirement  !== undefined) data.requirement  = body.requirement;
    if (body.timeline     !== undefined) data.timeline     = body.timeline;
    if (body.notes        !== undefined) data.notes        = body.notes;
    if (body.lostReason   !== undefined) data.lostReason   = body.lostReason;

    if (body.score !== undefined) {
      data.score      = body.score;
      data.scoreLabel = scoreLabelFor(body.score);
    } else if (body.scoreLabel !== undefined) {
      data.scoreLabel = body.scoreLabel;
    }

    if (body.stageId !== undefined && body.stageId !== lead.stageId) {
      const stage = await this.prisma.pipelineStage.findFirst({
        where: { id: body.stageId, tenantId: scope.tenantId },
      });
      if (!stage) throw new BadRequestException('Stage not found or does not belong to tenant');
      data.stageId = body.stageId;
      nextStageName = stage.name;
      if (stage.outcome === 'WON' || stage.outcome === 'LOST') {
        data.closedAt = new Date();
        closesLead = !lead.closedAt;
      }
    }

    const updated = await this.prisma.lead.update({ where: { id }, data });
    if (body.stageId !== undefined && body.stageId !== lead.stageId) {
      const variables = {
        leadId: lead.id,
        leadTitle: updated.title,
        previousStage: lead.stage?.name ?? '',
        leadStage: nextStageName ?? '',
      };
      this.dispatchFlowTrigger(scope, lead.contactId, 'LEAD_STATUS_CHANGED', variables);
      if (closesLead) this.dispatchFlowTrigger(scope, lead.contactId, 'LEAD_CLOSED', variables);
    }
    return updated;
  }

  private async dispatchFlowTrigger(
    scope: TenantScope,
    contactId: string,
    trigger: 'CONTACT_CREATED' | 'LEAD_CREATED' | 'LEAD_STATUS_CHANGED' | 'LEAD_CLOSED',
    variables: Record<string, string>,
  ): Promise<void> {
    try {
      await this.flowPipeline.triggerFlowForEvent({
        tenantId: scope.tenantId,
        businessId: scope.businessId,
        contactId,
        trigger,
        variables,
      });
    } catch (err) {
      this.logger.warn(`Could not trigger ${trigger} flow for lead contact ${contactId}: ${(err as Error).message}`);
    }
  }

  async deleteLead(scope: TenantScope, id: string) {
    await this.getLead(scope, id);
    await this.prisma.lead.delete({ where: { id } });
    return { deleted: true };
  }

  async addActivity(
    scope: TenantScope,
    leadId: string,
    body: { type: string; content?: string; metadata?: unknown },
  ) {
    await this.getLead(scope, leadId);
    return this.prisma.leadActivity.create({
      data: {
        leadId,
        userId:   scope.userId,
        type:     body.type,
        content:  body.content,
        metadata: body.metadata as any,
      },
    });
  }

  async importLeads(
    scope: TenantScope,
    body: {
      leads: Array<{ phone: string; title: string; stageId?: string; value?: number; notes?: string }>;
    },
  ) {
    const defaultStage = await this.prisma.pipelineStage.findFirst({
      where:   { tenantId: scope.tenantId, isDefault: true },
      orderBy: { order: 'asc' },
    });

    let created = 0;
    let failed  = 0;
    const errors: Array<{ phone: string; error: string }> = [];

    for (const item of body.leads) {
      try {
        const stageId = item.stageId ?? defaultStage?.id;
        if (!stageId) throw new Error('No stage specified and no default stage configured');

        const phone = normalizePhone(item.phone);
        if (phone.length < 8) throw new Error('phone must include the country code, like 919876543210');
        const existingContact = await this.prisma.contact.findUnique({
          where: { phone_businessId: { phone, businessId: scope.businessId } },
          select: { id: true },
        });
        const contact = await this.prisma.contact.upsert({
          where:  { phone_businessId: { phone, businessId: scope.businessId } },
          create: {
            tenantId:   scope.tenantId,
            businessId: scope.businessId,
            name:       phone,
            phone,
          },
          update: {},
        });

        if (!existingContact) {
          await this.dispatchFlowTrigger(scope, contact.id, 'CONTACT_CREATED', {
            contactName: contact.name,
            contactPhone: contact.phone,
          });
        }

        const lead = await this.prisma.lead.create({
          data: {
            tenantId:   scope.tenantId,
            businessId: scope.businessId,
            contactId:  contact.id,
            title:      item.title,
            stageId,
            score:      0,
            scoreLabel: 'COLD' as any,
            value:      item.value,
            notes:      item.notes,
          },
        });
        await this.dispatchFlowTrigger(scope, contact.id, 'LEAD_CREATED', {
          leadId: lead.id,
          leadTitle: lead.title,
          leadStage: stageId,
        });
        created++;
      } catch (err: any) {
        failed++;
        errors.push({ phone: item.phone, error: err?.message ?? 'Unknown error' });
      }
    }

    return { created, failed, errors };
  }
}
