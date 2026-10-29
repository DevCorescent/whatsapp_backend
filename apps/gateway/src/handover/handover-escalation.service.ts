import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '@lib/prisma';
import { HANDOVER_REASON_LABELS, MANAGER_ROLES, NotificationsService, type HandoverReason } from '@lib/common';

/**
 * Handovers nobody has picked up.
 *
 * A conversation handed to a person and then ignored is worse than one the AI kept: the
 * customer has been promised a human and is waiting. Each workspace sets how long it is
 * willing to wait, and managers hear about it once per handover.
 */
@Injectable()
export class HandoverEscalationService {
  private readonly logger = new Logger(HandoverEscalationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweep(): Promise<void> {
    const configs = await this.prisma.handoverConfig.findMany({
      where:  { enabled: true, escalateAfterMinutes: { gt: 0 } },
      select: { businessId: true, tenantId: true, escalateAfterMinutes: true },
    }).catch(() => []);
    if (!configs.length) return;

    for (const config of configs) {
      const cutoff = new Date(Date.now() - config.escalateAfterMinutes * 60 * 1000);

      // Still unaccepted, old enough, and not already reported.
      const stale = await this.prisma.handoverRequest.findMany({
        where: {
          businessId:  config.businessId,
          status:      { in: ['PENDING', 'ASSIGNED'] },
          requestedAt: { lt: cutoff },
          escalatedAt: null,
        },
        take: 50,
        include: { conversation: { select: { contact: { select: { name: true, phone: true } } } } },
      }).catch(() => []);

      for (const handover of stale) {
        const who = handover.conversation?.contact.name || handover.conversation?.contact.phone || 'A customer';
        const waited = Math.round((Date.now() - handover.requestedAt.getTime()) / 60000);

        void this.notifications.notify({
          tenantId:   config.tenantId,
          businessId: config.businessId,
          recipients: { roles: MANAGER_ROLES },
          type:       'HANDOVER_REQUESTED',
          title:      `${who} has been waiting ${waited} minutes`,
          body:       `${HANDOVER_REASON_LABELS[handover.reason as HandoverReason] ?? 'Handed over'}, and nobody has picked it up.`,
          href:       '/handovers',
          data:       { handoverId: handover.id, conversationId: handover.conversationId, waitedMinutes: waited },
        });

        // Stamped whether or not the notification lands, so this fires once per handover
        // rather than every five minutes for the rest of the day.
        await this.prisma.handoverRequest.update({
          where: { id: handover.id },
          data:  { escalatedAt: new Date() },
        }).catch(() => {});
      }

      if (stale.length) {
        this.logger.warn(`${stale.length} handover(s) escalated in business ${config.businessId}`);
      }
    }
  }
}
