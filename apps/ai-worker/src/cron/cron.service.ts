import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '@lib/prisma';
import { QUEUE_CAMPAIGN_SEND, QUEUE_TEMPLATE_SYNC, CampaignSendJob } from '@lib/queue';

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_CAMPAIGN_SEND)  private readonly sendQueue: Queue,
    @InjectQueue(QUEUE_TEMPLATE_SYNC)  private readonly syncQueue: Queue,
  ) {}

  // ── Campaign scheduler: runs every minute, picks up SCHEDULED campaigns ───

  @Cron(CronExpression.EVERY_MINUTE)
  async scheduleCampaigns() {
    const due = await this.prisma.campaign.findMany({
      where: {
        status:      'SCHEDULED',
        scheduledAt: { lte: new Date() },
      },
      select: { id: true, tenantId: true, businessId: true },
    });

    for (const c of due) {
      this.logger.log(`Launching scheduled campaign ${c.id}`);
      try {
        await this.prisma.campaign.update({ where: { id: c.id }, data: { status: 'RUNNING', startedAt: new Date() } });

        const recipients = await this.prisma.campaignContact.findMany({
          where: { campaignId: c.id, status: 'PENDING' },
          select: { id: true },
        });

        const jobs = recipients.map(r => ({
          data: {
            tenantId:    c.tenantId,
            businessId:  c.businessId,
            campaignId:  c.id,
            recipientId: r.id,
          } satisfies CampaignSendJob,
          opts: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        }));

        if (jobs.length) await this.sendQueue.addBulk(jobs);
        this.logger.log(`Enqueued ${jobs.length} recipients for campaign ${c.id}`);
      } catch (err: any) {
        this.logger.error(`Failed to launch campaign ${c.id}: ${err.message}`);
      }
    }
  }

  // ── Retention: delete old messages per plan retentionDays, runs daily ─────

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async runRetention() {
    this.logger.log('Starting retention cleanup');
    const subscriptions = await this.prisma.subscription.findMany({
      include: { plan: { select: { retentionDays: true } } },
    });

    for (const sub of subscriptions) {
      const days = sub.plan.retentionDays;
      if (!days || days <= 0) continue;

      const cutoff = new Date(Date.now() - days * 86_400_000);
      const result = await this.prisma.message.deleteMany({
        where: {
          tenantId:  sub.tenantId,
          createdAt: { lt: cutoff },
        },
      });

      if (result.count > 0) {
        this.logger.log(`Retention: deleted ${result.count} messages for tenant ${sub.tenantId}`);
      }
    }
  }

  // ── Template sync: re-check PENDING templates hourly ─────────────────────

  @Cron(CronExpression.EVERY_HOUR)
  async syncPendingTemplates() {
    const pending = await this.prisma.messageTemplate.findMany({
      where: { status: 'PENDING', waTemplateId: { not: null } },
      select: { id: true, tenantId: true, businessId: true, waTemplateId: true },
    });

    for (const t of pending) {
      this.logger.debug(`Re-syncing template ${t.id} (${t.waTemplateId})`);
      await this.syncQueue.add({
        tenantId:   t.tenantId,
        businessId: t.businessId,
        templateId: t.id,
      });
    }
  }
}
