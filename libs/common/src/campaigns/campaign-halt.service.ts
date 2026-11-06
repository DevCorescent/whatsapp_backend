import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { RedisService } from '../redis/redis.service';
import { MANAGER_ROLES, NotificationsService } from '../notifications/notifications.service';
import { WebhookDispatchService } from '../webhook-dispatch.service';

/**
 * Stops a campaign whose every remaining send would fail the same way.
 *
 * This lives here, rather than in the send processor that first needed it, because the
 * errors worth halting on mostly do **not** come back from the send call. Meta accepts the
 * message, answers with an id, and reports the failure two seconds later on the status
 * webhook — which is a different app, and had no halt at all. A billing failure therefore
 * pushed every recipient of a campaign to Meta, had each one accepted, and then failed all
 * of them one webhook at a time, with no pause, nobody told, and the campaign reported
 * "completed" having sent nothing.
 *
 * Pending recipients are left pending, so resuming after fixing the cause carries on
 * instead of re-sending to the people who already received it.
 */
@Injectable()
export class CampaignHaltService {
  private readonly logger = new Logger(CampaignHaltService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
    private readonly webhooks: WebhookDispatchService,
  ) {}

  static key(campaignId: string): string {
    return `campaign:halted:${campaignId}`;
  }

  /** True when this campaign has been halted and no further job should claim from it. */
  async isHalted(campaignId: string): Promise<boolean> {
    try {
      return (await this.redis.client.exists(CampaignHaltService.key(campaignId))) === 1;
    } catch {
      // Redis is unreachable. The caller's cached campaign status is the fallback.
      return false;
    }
  }

  /**
   * Pauses the campaign and tells the managers why. Safe to call repeatedly and from
   * either app — only the call that actually pauses it sends the notification.
   */
  async halt(args: {
    campaignId: string;
    tenantId: string;
    businessId?: string;
    reason: string;
    errorCode: number | null;
  }): Promise<void> {
    const { campaignId, tenantId, reason, errorCode } = args;

    const [remaining, current] = await Promise.all([
      this.prisma.campaignContact.count({ where: { campaignId, status: 'PENDING' } }),
      this.prisma.campaign.findUnique({
        where:  { id: campaignId },
        select: { sentCount: true, businessId: true, status: true },
      }),
    ]);

    // What the campaign becomes depends on what is left and what got through.
    //
    // COMPLETED is included deliberately. A campaign is marked complete the moment Meta
    // accepts the last message, which is seconds before it reports whether it will send
    // any of them — so a billing failure consistently arrived at a campaign that had
    // already declared itself finished, and the halt matched nothing. That completion is
    // provisional, and this is where it gets corrected.
    const nextStatus =
      remaining > 0                        ? 'PAUSED'   // there is something to resume
      : (current?.sentCount ?? 0) === 0    ? 'FAILED'   // nothing got through at all
      : null;                                           // most of it did — leave it complete

    const halted = await this.prisma.campaign.updateMany({
      where: { id: campaignId, status: { in: ['RUNNING', 'PROCESSING', 'COMPLETED'] } },
      data: {
        ...(nextStatus ? { status: nextStatus } : {}),
        haltedAt: new Date(),
        haltReason: reason.slice(0, 500),
        haltErrorCode: errorCode,
        lastError: reason.slice(0, 500),
      },
    });

    // The flag is set whether or not this call was the one to pause it, because a worker
    // holding a cached campaign row would otherwise keep sending until the cache expired.
    await this.redis.client
      .set(CampaignHaltService.key(campaignId), reason.slice(0, 500), 'EX', 24 * 60 * 60)
      .catch((err) => this.logger.error(`Could not flag halt for ${campaignId}: ${err.message}`));

    if (halted.count === 0) return; // already halted — only notify once

    const businessId = args.businessId ?? current?.businessId;
    if (!businessId) {
      this.logger.error(`Campaign ${campaignId} halted but its business is unknown — nobody notified`);
      return;
    }

    this.logger.error(`Campaign ${campaignId} halted (code ${errorCode ?? 'none'}): ${reason}`);

    // Telling someone to "resume" a campaign with nobody left to send to would send them
    // looking for a button that cannot help them.
    void this.notifications.notify({
      tenantId,
      businessId,
      recipients: { roles: MANAGER_ROLES },
      type: 'SYSTEM',
      title: remaining > 0 ? 'Campaign paused by WhatsApp' : 'Campaign stopped by WhatsApp',
      body: remaining > 0
        ? `${reason} ${remaining.toLocaleString()} recipient${remaining === 1 ? '' : 's'} not sent. Fix the cause, then resume.`
        : `${reason} Nothing was sent. Fix the cause, then send it again.`,
      href: `/campaigns/${campaignId}`,
      data: { campaignId, errorCode },
    });
    this.webhooks.dispatchEvent(tenantId, 'campaign.paused', {
      campaignId, reason, errorCode, remaining,
    });
  }
}
