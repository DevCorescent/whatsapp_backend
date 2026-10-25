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

  // ── White-label monthly fee: runs daily ───────────────────────────────────

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async runWhiteLabelBilling() {
    const resellers = await this.prisma.tenant.findMany({
      where: {
        accountType:  'RESELLER',
        resellerType: 'WHITE_LABEL',
        isActive:     true,
        whiteLabel:   { isNot: null },
      },
      select: { id: true, whiteLabel: true },
    });

    const platform = await this.prisma.platformConfig.upsert({
      where:  { id: 'platform' },
      create: { id: 'platform' },
      update: {},
    });

    const now = new Date();
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    const tally: Record<string, number> = {};

    for (const { id: tenantId, whiteLabel: wl } of resellers) {
      try {
        const feeMinor = (wl as any)?.feeOverrideMinor ?? (platform as any).whiteLabelFeeMinor ?? 0;
        const idempotencyKey = `wlfee:${tenantId}:${period}`;

        if (feeMinor <= 0) {
          // Free tier — clear any stale due markers
          if ((wl as any)?.feeDueSince) {
            await this.prisma.whiteLabelConfig.update({
              where: { tenantId },
              data:  { feeDueSince: null },
            });
          }
          tally.free = (tally.free ?? 0) + 1;
          continue;
        }

        // Idempotency: skip if already charged this month
        const prior = await this.prisma.walletTransaction.findUnique({
          where: { idempotencyKey },
          select: { id: true, balanceAfterMinor: true },
        });
        if (prior) {
          // Already charged — ensure due markers are cleared
          if ((wl as any)?.feeDueSince) {
            await this.prisma.whiteLabelConfig.update({
              where: { tenantId },
              data:  { feeDueSince: null, suspendedAt: null, suspendedReason: null },
            });
          }
          tally.already_paid = (tally.already_paid ?? 0) + 1;
          continue;
        }

        // Atomic debit — never below zero
        await this.prisma.wallet.upsert({ where: { tenantId }, create: { tenantId }, update: {} });

        const paid = await this.prisma.$transaction(async (tx) => {
          const taken = await tx.wallet.updateMany({
            where: { tenantId, balanceMinor: { gte: feeMinor } },
            data:  { balanceMinor: { decrement: feeMinor } },
          });
          if (taken.count === 0) return false;
          const w = await tx.wallet.findUniqueOrThrow({ where: { tenantId }, select: { balanceMinor: true } });
          await tx.walletTransaction.create({
            data: {
              tenantId,
              type:              'DEBIT',
              amountMinor:       -feeMinor,
              balanceAfterMinor: w.balanceMinor,
              idempotencyKey,
              description:       `White-label fee — ${period}`,
              referenceType:     'white_label_fee',
              referenceId:       period,
            },
          });
          return true;
        });

        if (paid) {
          // Clear any due/suspension markers on successful payment
          if ((wl as any)?.feeDueSince || (wl as any)?.suspendedAt) {
            await this.prisma.whiteLabelConfig.update({
              where: { tenantId },
              data:  { feeDueSince: null, suspendedAt: null, suspendedReason: null },
            });
          }
          tally.paid = (tally.paid ?? 0) + 1;
        } else {
          // Insufficient funds — apply grace / suspension
          const dueSince = (wl as any)?.feeDueSince ?? now;
          const graceDays = (platform as any).whiteLabelGraceDays ?? 7;
          if (!(wl as any)?.feeDueSince) {
            await this.prisma.whiteLabelConfig.update({
              where: { tenantId },
              data:  { feeDueSince: dueSince },
            });
          }
          const graceEnds = new Date(dueSince.getTime() + graceDays * 86_400_000);
          if (!(wl as any)?.suspendedAt && now >= graceEnds) {
            await this.prisma.whiteLabelConfig.update({
              where: { tenantId },
              data:  { suspendedAt: now, suspendedReason: 'White-label fee unpaid' },
            });
            tally.suspended = (tally.suspended ?? 0) + 1;
          } else {
            tally.due = (tally.due ?? 0) + 1;
          }
        }
      } catch (err: any) {
        tally.error = (tally.error ?? 0) + 1;
        this.logger.error(`White-label billing failed for tenant ${tenantId}: ${err.message}`);
      }
    }

    this.logger.log(`White-label billing done: ${JSON.stringify(tally)}`);
  }
}
