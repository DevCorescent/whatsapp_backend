import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { RealtimeService } from '@lib/common';

const THROTTLE_MS = 1_000;

/**
 * Pushes `campaign:progress` to the business room. Per-recipient outcomes are
 * throttled to one emit per second per campaign (with a trailing emit so the
 * final counters always land); status changes emit immediately.
 */
@Injectable()
export class CampaignProgressService {
  private readonly logger = new Logger(CampaignProgressService.name);
  private readonly timers = new Map<string, { timer: NodeJS.Timeout; dirty: boolean }>();

  constructor(
    private readonly prisma:   PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Coalesces bursts of recipient updates. */
  touch(campaignId: string) {
    const pending = this.timers.get(campaignId);
    if (pending) {
      pending.dirty = true;
      return;
    }
    void this.emitNow(campaignId);
    const entry = {
      dirty: false,
      timer: setTimeout(() => {
        this.timers.delete(campaignId);
        if (entry.dirty) this.touch(campaignId);
      }, THROTTLE_MS),
    };
    this.timers.set(campaignId, entry);
  }

  async emitNow(campaignId: string) {
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
      this.logger.warn(`campaign:progress emit failed ${campaignId}: ${err?.message ?? err}`);
    }
  }
}
