import { Injectable } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(scope: TenantScope, from: Date, to: Date) {
    const bid  = scope.businessId;
    const dateFilter  = { gte: from, lte: to };
    const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000));

    // Previous period for delta calculation
    const span     = to.getTime() - from.getTime();
    const prevFrom = new Date(from.getTime() - span);
    const prevFilter = { gte: prevFrom, lte: from };

    const [
      totalMessages,
      totalConversations,
      openConversations,
      resolvedToday,
      totalLeads,
      wonLeads,
      prevMessages,
      prevConversations,
      prevOpen,
      prevResolved,
      leadsByStageRaw,
      campaignPerformance,
      agentPerformance,
      // For messages chart: fetch all messages in period grouped by day in memory
      messagesInPeriod,
    ] = await Promise.all([
      this.prisma.message.count({ where: { businessId: bid, createdAt: dateFilter } }),
      this.prisma.conversation.count({ where: { businessId: bid, createdAt: dateFilter } }),
      this.prisma.conversation.count({ where: { businessId: bid, status: 'OPEN' } }),
      this.prisma.conversation.count({
        where: {
          businessId: bid,
          status: 'RESOLVED',
          updatedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
      this.prisma.lead.count({ where: { businessId: bid, createdAt: dateFilter } }),
      this.prisma.lead.count({
        where: { businessId: bid, closedAt: { not: null }, stage: { outcome: 'WON' } },
      }),
      // Previous period
      this.prisma.message.count({ where: { businessId: bid, createdAt: prevFilter } }),
      this.prisma.conversation.count({ where: { businessId: bid, createdAt: prevFilter } }),
      this.prisma.conversation.count({ where: { businessId: bid, status: 'OPEN', updatedAt: prevFilter } }),
      this.prisma.conversation.count({ where: { businessId: bid, status: 'RESOLVED', updatedAt: prevFilter } }),
      // Leads by stage
      this.prisma.lead.groupBy({
        by: ['stageId'],
        where: { businessId: bid },
        _count: { _all: true },
      }),
      // Top 5 campaigns in period
      this.prisma.campaign.findMany({
        where:   { businessId: bid, createdAt: dateFilter },
        orderBy: { sentCount: 'desc' },
        take:    5,
        select: { id: true, name: true, sentCount: true, deliveredCount: true, readCount: true, repliedCount: true },
      }),
      // Agent performance
      this.prisma.conversation.groupBy({
        by: ['assignedToId'],
        where: { businessId: bid, createdAt: dateFilter, assignedToId: { not: null } },
        _count: { _all: true },
      }),
      // Fetch all message timestamps in period for chart
      this.prisma.message.findMany({
        where:  { businessId: bid, createdAt: dateFilter },
        select: { createdAt: true, direction: true },
      }),
    ]);

    const conversionRate = totalLeads > 0 ? Math.round((wonLeads / totalLeads) * 100) : 0;

    // Build daily chart from in-memory messages
    const dayMap = new Map<string, { sent: number; received: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(to.getTime() - i * 86400000);
      dayMap.set(d.toISOString().slice(0, 10), { sent: 0, received: 0 });
    }
    for (const m of messagesInPeriod) {
      const key = m.createdAt.toISOString().slice(0, 10);
      const entry = dayMap.get(key);
      if (entry) {
        if (m.direction === 'OUTBOUND') entry.sent++;
        else entry.received++;
      }
    }
    const messagesChart = Array.from(dayMap.entries()).map(([date, v]) => ({ date, ...v }));

    // Resolve stage names
    const stageIds = leadsByStageRaw.map((l) => (l as any).stageId).filter(Boolean) as string[];
    const stages = stageIds.length
      ? await this.prisma.pipelineStage.findMany({ where: { id: { in: stageIds } }, select: { id: true, name: true } })
      : [];
    const stageMap = new Map(stages.map((s) => [s.id, s.name]));
    const leadsByStage = leadsByStageRaw.map((l) => ({
      stage: stageMap.get((l as any).stageId) ?? 'Unknown',
      count: (l._count as any)._all ?? 0,
    }));

    // Resolve agent names
    const agentIds = agentPerformance.map((a) => (a as any).assignedToId).filter(Boolean) as string[];
    const agents = agentIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } })
      : [];
    const agentMap = new Map(agents.map((u) => [u.id, u.name]));
    const agentPerf = agentPerformance.map((a) => ({
      name:          agentMap.get((a as any).assignedToId) ?? 'Unknown',
      conversations: (a._count as any)._all ?? 0,
    }));

    const campaignPerf = campaignPerformance.map((c) => ({
      id: c.id, name: c.name,
      sent:      c.sentCount      ?? 0,
      delivered: c.deliveredCount ?? 0,
      read:      c.readCount      ?? 0,
      replied:   c.repliedCount   ?? 0,
    }));

    const delta = (cur: number, prev: number): number | null =>
      prev === 0 ? null : Math.round(((cur - prev) / prev) * 100);

    return {
      totalConversations,
      openConversations,
      resolvedToday,
      totalMessages,
      avgResponseTimeMinutes: 0,
      totalLeads,
      wonDeals: wonLeads,
      conversionRate,
      leadsByStage,
      messagesChart,
      scoreDistribution:   [{ label: 'Unscored', count: totalLeads }],
      campaignPerformance: campaignPerf,
      agentPerformance:    agentPerf,
      deltas: {
        totalConversations: delta(totalConversations, prevConversations),
        openConversations:  delta(openConversations,  prevOpen),
        resolvedToday:      delta(resolvedToday,       prevResolved),
        totalMessages:      delta(totalMessages,       prevMessages),
        avgResponseTimeMinutes: null,
        totalLeads:         null,
        wonDeals:           null,
        conversionRate:     null,
      },
    };
  }
}
