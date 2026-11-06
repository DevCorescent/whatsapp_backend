import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import {
  RealtimeService, SuppressionService, CampaignHaltService, classifySendError,
  type RtStatusUpdate,
} from '@lib/common';

interface Buffered {
  tenantId:    string;
  waMessageId: string;
  status:      string;
  rank:        number;
  errorCode?:  number;
  errorTitle?: string;
}

const STATUS_RANK: Record<string, number> = {
  pending: 0, sent: 1, delivered: 2, read: 3, failed: 4,
};

// Statuses that are "lower" than each target — used to make updates monotonic
// without a statusRank DB column.
const LOWER_STATUSES: Record<string, string[]> = {
  sent:      ['PENDING'],
  delivered: ['PENDING', 'SENT'],
  read:      ['PENDING', 'SENT', 'DELIVERED'],
  failed:    ['PENDING', 'SENT', 'DELIVERED', 'READ'],
};

const CAMPAIGN_COUNTER: Record<string, 'deliveredCount' | 'readCount' | 'failedCount'> = {
  delivered: 'deliveredCount',
  read:      'readCount',
  failed:    'failedCount',
};

@Injectable()
export class StatusBufferService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StatusBufferService.name);

  // keyed by waMessageId — keeps the highest-rank status per message
  private readonly pending = new Map<string, Buffered>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma:   PrismaService,
    private readonly realtime: RealtimeService,
    private readonly suppression: SuppressionService,
    private readonly halt: CampaignHaltService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => { void this.flush(); }, 1_000);
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  buffer(tenantId: string, waMessageId: string, status: string, extras?: {
    errorCode?: number; errorTitle?: string;
  }) {
    const rank = STATUS_RANK[status] ?? -1;
    if (rank < 0) return;

    const existing = this.pending.get(waMessageId);
    if (existing && existing.rank >= rank) return; // already at higher/equal rank

    this.pending.set(waMessageId, { tenantId, waMessageId, status, rank, ...extras });
  }

  async flush() {
    if (this.pending.size === 0) return;

    // Snapshot and clear atomically
    const items = [...this.pending.values()];
    this.pending.clear();

    // Group by (tenantId, status) for bulk updateMany
    const groups = new Map<string, Buffered[]>();
    for (const item of items) {
      const key = `${item.tenantId}:${item.status}`;
      const g = groups.get(key);
      if (g) g.push(item);
      else groups.set(key, [item]);
    }

    const touchedCampaigns = new Set<string>();

    for (const group of groups.values()) {
      const { tenantId, status } = group[0];
      const ids = group.map(g => g.waMessageId);
      const lowerStatuses = LOWER_STATUSES[status] ?? [];
      const now = new Date();

      try {
        await this.prisma.message.updateMany({
          where: { tenantId, waMessageId: { in: ids }, status: { in: lowerStatuses as never[] } },
          data:  { status: status.toUpperCase() as never },
        });
      } catch (err: any) {
        this.logger.error(`message flush (${status}): ${err.message}`);
      }

      await this.flushCampaignContacts(group, status, now, touchedCampaigns);
      await this.emitMessageStatuses(group, status);
    }

    for (const campaignId of touchedCampaigns) await this.emitCampaignProgress(campaignId);

    this.logger.debug(`Flushed ${items.length} status updates`);
  }

  /** Per-recipient rows plus the campaign's aggregate counters (only for real transitions). */
  private async flushCampaignContacts(group: Buffered[], status: string, now: Date, touched: Set<string>) {
    const counter = CAMPAIGN_COUNTER[status];
    if (!counter) return;
    const ids = group.map(g => g.waMessageId);

    let rows: { id: string; campaignId: string; status: string; waMessageId: string | null }[];
    try {
      rows = await this.prisma.campaignContact.findMany({
        where:  { waMessageId: { in: ids } },
        select: { id: true, campaignId: true, status: true, waMessageId: true },
      });
    } catch (err: any) {
      this.logger.error(`campaignContact lookup (${status}): ${err.message}`);
      return;
    }
    if (rows.length === 0) return;

    const rank = STATUS_RANK[status];
    const transitioning = rows.filter(r => (STATUS_RANK[r.status.toLowerCase()] ?? 0) < rank);
    if (transitioning.length === 0) return;

    const byId = new Map(group.map(g => [g.waMessageId, g]));
    const ops: Promise<unknown>[] = [];

    // Campaigns to stop, decided below and acted on once the counters have been written:
    // the halt reads sentCount to tell "nothing got through" from "most of it did", and
    // this same flush is what decrements it.
    const aborts = new Map<string, { reason: string; code: number | null }>();
    // Every group shares one tenant — they are keyed by it.
    const groupTenantId = group[0].tenantId;

    if (status === 'delivered') {
      ops.push(this.prisma.campaignContact.updateMany({
        where: { id: { in: transitioning.map(r => r.id) } },
        data:  { status: 'DELIVERED', deliveredAt: now },
      }));
    } else if (status === 'read') {
      ops.push(this.prisma.campaignContact.updateMany({
        where: { id: { in: transitioning.map(r => r.id) } },
        data:  { status: 'READ', readAt: now },
      }));
    } else if (status === 'failed') {
      // An error every remaining recipient would also hit stops the campaign. This has to
      // happen here and not only where the send is made: Meta accepts the message, hands
      // back an id, and reports a billing or account failure on this webhook seconds
      // later. Without it, a campaign pushed every recipient to Meta, had each accepted,
      // then failed all of them one webhook at a time — nobody told, nothing paused, and
      // the campaign reported "completed" having sent nothing.
      for (const row of transitioning) {
        const b = byId.get(row.waMessageId ?? '');
        const rule = classifySendError(b?.errorCode);
        if (rule.action === 'ABORT' && !aborts.has(row.campaignId)) {
          aborts.set(row.campaignId, { reason: rule.reason, code: b?.errorCode ?? null });
        }
        ops.push(this.prisma.campaignContact.update({
          where: { id: row.id },
          data:  {
            status: 'FAILED', failedAt: now,
            ...(b?.errorCode !== undefined
              ? {
                  errorCode:  b.errorCode,
                  errorTitle: b.errorTitle,
                  // Our own wording explains what to do about it; Meta's title alone does not.
                  failedReason: `${rule.reason}${b.errorCode ? ` (WhatsApp error ${b.errorCode})` : ''}`.slice(0, 500),
                }
              : {}),
          },
        }));
      }
    }

    // A message can be accepted and then fail on delivery, so an opt-out often arrives
    // here rather than as a rejected send. Same conclusion either way: stop sending.
    if (status === 'failed') void this.applySuppressions(group, transitioning);

    // Deliveries that failed because the person opted out, or had already had their fill
    // of marketing for the day, are counted apart from genuine delivery failures.
    const perCampaign = new Map<string, { failed: number; skipped: number }>();
    for (const r of transitioning) {
      const code = byId.get(r.waMessageId ?? '')?.errorCode;
      const skip = status === 'failed' && (code === 131050 || code === 131049);
      const tally = perCampaign.get(r.campaignId) ?? { failed: 0, skipped: 0 };
      if (skip) tally.skipped++; else tally.failed++;
      perCampaign.set(r.campaignId, tally);
    }
    for (const [campaignId, tally] of perCampaign) {
      const data: Record<string, { increment: number } | { decrement: number }> = {};
      if (status === 'failed') {
        if (tally.failed)  data.failedCount  = { increment: tally.failed };
        if (tally.skipped) data.skippedCount = { increment: tally.skipped };

        // A message WhatsApp accepted and later refused was counted as sent at the time,
        // so it has to stop being counted as sent now. Leaving it caused two problems:
        // the report read "2 sent, 2 failed" out of 2 recipients, which cannot both be
        // true, and completion is decided by sent + failed + skipped reaching the total —
        // so double-counting could finish a campaign while recipients were still pending.
        //
        // Every row here was matched by its WhatsApp message id, which only exists once a
        // send has succeeded, so each one was counted and the decrement is sound.
        const counted = tally.failed + tally.skipped;
        if (counted) data.sentCount = { decrement: counted };
      } else {
        data[counter] = { increment: tally.failed + tally.skipped };
      }
      ops.push(this.prisma.campaign.update({ where: { id: campaignId }, data }));
      touched.add(campaignId);
    }

    const results = await Promise.allSettled(ops);
    for (const r of results) if (r.status === 'rejected') this.logger.error(`campaign flush (${status}): ${r.reason?.message ?? r.reason}`);

    for (const [campaignId, a] of aborts) {
      await this.halt
        .halt({ campaignId, tenantId: groupTenantId, reason: a.reason, errorCode: a.code })
        .catch((err) => this.logger.error(`Could not halt ${campaignId}: ${err.message}`));
    }
  }

  /**
   * Error 131050 on a delivery receipt means this person has turned off marketing
   * messages. Record it against the number so no later campaign tries again.
   */
  private async applySuppressions(
    group: Buffered[],
    rows: { id: string; campaignId: string; waMessageId: string | null }[],
  ): Promise<void> {
    const optedOut = new Set(group.filter((g) => g.errorCode === 131050).map((g) => g.waMessageId));
    if (!optedOut.size) return;

    const ids = rows.filter((r) => r.waMessageId && optedOut.has(r.waMessageId)).map((r) => r.id);
    if (!ids.length) return;

    try {
      const recipients = await this.prisma.campaignContact.findMany({
        where:  { id: { in: ids } },
        select: { phone: true, campaign: { select: { tenantId: true, businessId: true } } },
      });
      for (const r of recipients) {
        if (!r.campaign) continue;
        await this.suppression.suppress({
          tenantId:   r.campaign.tenantId,
          businessId: r.campaign.businessId,
          phone:      r.phone,
          errorCode:  131050,
          reason:     classifySendError(131050).reason,
        });
      }
    } catch (err: any) {
      this.logger.error(`Could not record opt-outs from delivery receipts: ${err.message}`);
    }
  }

  private async emitMessageStatuses(group: Buffered[], status: string) {
    let rows: { id: string; conversationId: string; businessId: string | null; status: string; waMessageId: string | null }[];
    try {
      rows = await this.prisma.message.findMany({
        where:  { waMessageId: { in: group.map(g => g.waMessageId) } },
        select: { id: true, conversationId: true, businessId: true, status: true, waMessageId: true },
      });
    } catch (err: any) {
      this.logger.error(`message status lookup: ${err.message}`);
      return;
    }
    const byWa = new Map(group.map(g => [g.waMessageId, g]));
    const perBusiness = new Map<string, RtStatusUpdate[]>();
    for (const row of rows) {
      if (!row.businessId) continue;
      const b = byWa.get(row.waMessageId ?? '');
      const update: RtStatusUpdate = { messageId: row.id, conversationId: row.conversationId, status: row.status };
      if (b?.errorCode !== undefined && status === 'failed') {
        update.errorCode  = b.errorCode;
        update.errorTitle = b.errorTitle;
      }
      const list = perBusiness.get(row.businessId) ?? [];
      list.push(update);
      perBusiness.set(row.businessId, list);
    }
    for (const [businessId, updates] of perBusiness) {
      this.realtime.toBusiness(businessId, 'message:status', { updates });
    }
  }

  private async emitCampaignProgress(campaignId: string) {
    try {
      const c = await this.prisma.campaign.findUnique({
        where:  { id: campaignId },
        select: {
          id: true, businessId: true, status: true, totalCount: true, sentCount: true, deliveredCount: true,
          readCount: true, repliedCount: true, failedCount: true, costMinor: true, completedAt: true,
        },
      });
      if (!c) return;
      this.realtime.toBusiness(c.businessId, 'campaign:progress', {
        id: c.id, status: c.status, totalCount: c.totalCount, sentCount: c.sentCount,
        deliveredCount: c.deliveredCount, readCount: c.readCount, repliedCount: c.repliedCount,
        failedCount: c.failedCount, costMinor: c.costMinor, completedAt: c.completedAt?.toISOString() ?? null,
      });
    } catch (err: any) {
      this.logger.warn(`campaign:progress emit failed ${campaignId}: ${err.message}`);
    }
  }
}
