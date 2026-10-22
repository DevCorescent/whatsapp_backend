import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

function scoreToLabel(score: number): string {
  if (score === 0)   return 'COLD';
  if (score <= 30)   return 'WARM';
  if (score <= 70)   return 'HOT';
  return 'QUALIFIED';
}

@Injectable()
export class LeadsService {
  constructor(private readonly prisma: PrismaService) {}

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
    query: {
      page?: number; limit?: number; search?: string;
      stageId?: string; assignedToId?: string; scoreLabel?: string;
    },
  ) {
    const page  = Math.max(1, query.page  ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const skip  = (page - 1) * limit;

    const where: any = { tenantId: scope.tenantId, businessId: scope.businessId };
    if (query.stageId)      where.stageId      = query.stageId;
    if (query.assignedToId) where.assignedToId = query.assignedToId;
    if (query.scoreLabel)   where.scoreLabel   = query.scoreLabel;
    if (query.search) {
      where.OR = [
        { title:   { contains: query.search, mode: 'insensitive' } },
        { contact: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [leads, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        skip,
        take:    limit,
        orderBy: { createdAt: 'desc' },
        include: {
          contact:    { select: { name: true, phone: true } },
          assignedTo: { select: { name: true } },
          stage:      { select: { name: true, color: true, outcome: true } },
          _count:     { select: { activities: true } },
        },
      }),
      this.prisma.lead.count({ where }),
    ]);

    return { leads, total, page, limit };
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
    return this.prisma.lead.create({
      data: {
        tenantId:        scope.tenantId,
        businessId:      scope.businessId,
        contactId:       body.contactId,
        title:           body.title,
        stageId:         body.stageId,
        score,
        scoreLabel:      scoreToLabel(score) as any,
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
      data.scoreLabel = scoreToLabel(body.score);
    } else if (body.scoreLabel !== undefined) {
      data.scoreLabel = body.scoreLabel;
    }

    if (body.stageId !== undefined && body.stageId !== lead.stageId) {
      const stage = await this.prisma.pipelineStage.findFirst({
        where: { id: body.stageId, tenantId: scope.tenantId },
      });
      if (!stage) throw new BadRequestException('Stage not found or does not belong to tenant');
      data.stageId = body.stageId;
      if (stage.outcome === 'WON' || stage.outcome === 'LOST') {
        data.closedAt = new Date();
      }
    }

    return this.prisma.lead.update({ where: { id }, data });
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

        const contact = await this.prisma.contact.upsert({
          where:  { phone_businessId: { phone: item.phone, businessId: scope.businessId } },
          create: {
            tenantId:   scope.tenantId,
            businessId: scope.businessId,
            name:       item.phone,
            phone:      item.phone,
          },
          update: {},
        });

        await this.prisma.lead.create({
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
        created++;
      } catch (err: any) {
        failed++;
        errors.push({ phone: item.phone, error: err?.message ?? 'Unknown error' });
      }
    }

    return { created, failed, errors };
  }
}
