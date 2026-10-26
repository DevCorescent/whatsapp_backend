import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '@lib/prisma';
import { QUEUE_CAMPAIGN_SEND, CampaignSendJob } from '@lib/queue';

@Injectable()
export class CampaignSchedulerService {
  private readonly logger = new Logger(CampaignSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_CAMPAIGN_SEND) private readonly sendQueue: Queue,
  ) {}

  // ── Manual trigger (called from controller for debugging) ─────────────────

  async triggerNow(): Promise<{ found: number; launched: number; errors: string[] }> {
    return this.runScheduler();
  }

  // ── Cron: every minute ────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_MINUTE)
  async scheduledRun() {
    const result = await this.runScheduler();
    if (result.found > 0 || result.errors.length > 0) {
      this.logger.log(`Scheduler tick: found=${result.found} launched=${result.launched} errors=${result.errors.length}`);
    }
  }

  private async runScheduler(): Promise<{ found: number; launched: number; errors: string[] }> {
    const errors: string[] = [];
    let launched = 0;

    const due = await this.prisma.campaign.findMany({
      where: {
        status:      'SCHEDULED',
        scheduledAt: { lte: new Date() },
      },
      select: { id: true, tenantId: true, businessId: true, name: true, scheduledAt: true },
    });

    if (due.length === 0) return { found: 0, launched: 0, errors: [] };

    this.logger.log(`Campaign scheduler: ${due.length} due campaign(s)`);

    for (const c of due) {
      try {
        this.logger.log(`Launching campaign id=${c.id} name="${c.name}" scheduledAt=${c.scheduledAt?.toISOString()}`);

        // Transition to RUNNING atomically (if another process beat us, update returns 0 rows)
        const updated = await this.prisma.campaign.updateMany({
          where: { id: c.id, status: 'SCHEDULED' },
          data:  { status: 'RUNNING', startedAt: new Date() },
        });

        if (updated.count === 0) {
          this.logger.warn(`Campaign ${c.id} already claimed by another process — skipping`);
          continue;
        }

        const recipients = await this.prisma.campaignContact.findMany({
          where:  { campaignId: c.id, status: 'PENDING' },
          select: { id: true },
        });

        if (recipients.length === 0) {
          this.logger.warn(`Campaign ${c.id} has no PENDING recipients — marking COMPLETED`);
          await this.prisma.campaign.update({
            where: { id: c.id },
            data:  { status: 'COMPLETED', completedAt: new Date() },
          });
          launched++;
          continue;
        }

        // Check Redis queue health before bulk-adding
        let queueReady = false;
        try {
          await this.sendQueue.client.ping();
          queueReady = true;
        } catch (redisErr: any) {
          this.logger.error(`Redis PING failed before enqueue for campaign ${c.id}: ${redisErr.message}`);
          // Roll back status so the cron retries next minute
          await this.prisma.campaign.update({
            where: { id: c.id },
            data:  { status: 'SCHEDULED' },
          });
          errors.push(`campaign ${c.id}: Redis unavailable`);
          continue;
        }

        const jobs = recipients.map(r => ({
          data: {
            tenantId:    c.tenantId,
            businessId:  c.businessId,
            campaignId:  c.id,
            recipientId: r.id,
          } satisfies CampaignSendJob,
          opts: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        }));

        await this.sendQueue.addBulk(jobs);
        this.logger.log(`Campaign ${c.id}: enqueued ${jobs.length} jobs (Redis: ${queueReady})`);
        launched++;
      } catch (err: any) {
        this.logger.error(`Failed to launch campaign ${c.id}: ${err.message}`, err.stack);
        errors.push(`campaign ${c.id}: ${err.message}`);
        // Roll back so it retries next minute
        try {
          await this.prisma.campaign.updateMany({
            where: { id: c.id, status: 'RUNNING' },
            data:  { status: 'SCHEDULED' },
          });
        } catch { /* ignore rollback error */ }
      }
    }

    return { found: due.length, launched, errors };
  }

  // ── Queue health check (used by debug endpoint) ───────────────────────────

  async queueHealth(): Promise<Record<string, unknown>> {
    try {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        this.sendQueue.getWaitingCount(),
        this.sendQueue.getActiveCount(),
        this.sendQueue.getCompletedCount(),
        this.sendQueue.getFailedCount(),
        this.sendQueue.getDelayedCount(),
      ]);

      let redisPing: string;
      try {
        await this.sendQueue.client.ping();
        redisPing = 'ok';
      } catch (e: any) {
        redisPing = `ERROR: ${e.message}`;
      }

      return { redisPing, waiting, active, completed, failed, delayed };
    } catch (err: any) {
      return { error: err.message };
    }
  }
}
