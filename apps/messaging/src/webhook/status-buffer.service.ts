import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';

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

@Injectable()
export class StatusBufferService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StatusBufferService.name);

  // keyed by waMessageId — keeps the highest-rank status per message
  private readonly pending = new Map<string, Buffered>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.timer = setInterval(() => { void this.flush(); }, 5_000);
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

    const ops: Promise<unknown>[] = [];

    for (const group of groups.values()) {
      const { tenantId, status, rank } = group[0];
      const ids = group.map(g => g.waMessageId);

      const lowerStatuses = LOWER_STATUSES[status] ?? [];
      const now = new Date();

      // Bulk update messages table — status only (no timestamp columns on Message)
      ops.push(
        this.prisma.message.updateMany({
          where: { tenantId, waMessageId: { in: ids }, status: { in: lowerStatuses as never[] } },
          data:  { status: status.toUpperCase() as never },
        }).catch(err => this.logger.error(`message flush (${status}): ${err.message}`)),
      );

      // Bulk update campaign_contacts table (has deliveredAt / readAt / failedAt columns)
      if (status === 'delivered') {
        ops.push(
          this.prisma.campaignContact.updateMany({
            where: { waMessageId: { in: ids } },
            data:  { status: 'DELIVERED', deliveredAt: now },
          }).catch(err => this.logger.error(`campaignContact flush (delivered): ${err.message}`)),
        );
      } else if (status === 'read') {
        ops.push(
          this.prisma.campaignContact.updateMany({
            where: { waMessageId: { in: ids } },
            data:  { status: 'READ', readAt: now },
          }).catch(err => this.logger.error(`campaignContact flush (read): ${err.message}`)),
        );
      } else if (status === 'failed') {
        const failedNoCode = group.filter(g => g.errorCode === undefined);
        if (failedNoCode.length) {
          ops.push(
            this.prisma.campaignContact.updateMany({
              where: { waMessageId: { in: failedNoCode.map(g => g.waMessageId) } },
              data:  { status: 'FAILED', failedAt: now },
            }).catch(err => this.logger.error(`campaignContact flush (failed): ${err.message}`)),
          );
        }

        const codeGroups = new Map<string, Buffered[]>();
        for (const f of group.filter(g => g.errorCode !== undefined)) {
          const codeKey = `${f.errorCode}:${f.errorTitle ?? ''}`;
          const cg = codeGroups.get(codeKey);
          if (cg) cg.push(f);
          else codeGroups.set(codeKey, [f]);
        }
        for (const cg of codeGroups.values()) {
          const { errorCode, errorTitle } = cg[0];
          ops.push(
            this.prisma.campaignContact.updateMany({
              where: { waMessageId: { in: cg.map(g => g.waMessageId) } },
              data:  { status: 'FAILED', failedAt: now, errorCode, errorTitle, failedReason: errorTitle },
            }).catch(err => this.logger.error(`campaignContact flush (failed w/code): ${err.message}`)),
          );
        }
      }
    }

    await Promise.allSettled(ops);
    this.logger.debug(`Flushed ${items.length} status updates → ${ops.length} bulk DB ops`);
  }
}
