import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { PrismaService } from '@lib/prisma';
import {
  WebhookDispatchService, NotificationsService, MessageRatesService, WalletService, MANAGER_ROLES, decryptSecret,
  buildSendComponents, toSpec, RedisService, SuppressionService,
  classifySendError, describeSendError, parseSendError, type ParsedSendError,
} from '@lib/common';
import { QUEUE_CAMPAIGN_SEND, CampaignSendJob } from '@lib/queue';
import { CampaignProgressService } from '../campaign-progress.service';

const WA_API_VERSION = process.env.WHATSAPP_API_VERSION ?? 'v20.0';

// Shape cached per campaign — only immutable fields (template, integration credentials)
interface CampaignData {
  id:                   string;
  status:               string;
  tenantId:             string;
  totalCount:           number;
  metadata:             any;
  /** Everything the payload builder needs; loosely typed because the Json columns are. */
  template:             Record<string, any> | null;
  whatsappIntegration:  { phoneNumberId: string; accessToken: string | null } | null;
  businessId:           string;
}

@Processor(QUEUE_CAMPAIGN_SEND)
export class CampaignSendProcessor {
  private readonly logger = new Logger(CampaignSendProcessor.name);

  // Fix #1: Cache campaign + template + integration per run.
  // The same row is fetched on every recipient job — cache it for 30 min.
  private readonly campaignCache = new Map<string, { data: CampaignData; expiresAt: number }>();
  private readonly CACHE_TTL_MS = 30 * 60 * 1_000;

  constructor(
    private readonly prisma:    PrismaService,
    private readonly webhooks:  WebhookDispatchService,
    private readonly progress:  CampaignProgressService,
    private readonly notifications: NotificationsService,
    private readonly rates:     MessageRatesService,
    private readonly wallet:    WalletService,
    private readonly suppression: SuppressionService,
    private readonly redis:     RedisService,
  ) {}

  private async getCampaignData(campaignId: string): Promise<CampaignData | null> {
    const cached = this.campaignCache.get(campaignId);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const campaign = await this.prisma.campaign.findUnique({
      where:   { id: campaignId },
      select: {
        id: true, status: true, tenantId: true, totalCount: true, businessId: true,
        metadata: true,
        template: true,
        whatsappIntegration: {
          select: { phoneNumberId: true, accessToken: true },
        },
      },
    });
    if (!campaign) return null;

    this.campaignCache.set(campaignId, { data: campaign as CampaignData, expiresAt: Date.now() + this.CACHE_TTL_MS });
    return campaign as CampaignData;
  }

  @Process({ concurrency: 10 })
  async handle(job: Job<CampaignSendJob>) {
    const { campaignId, recipientId, tenantId, businessId } = job.data;

    this.logger.log(`Processing job id=${job.id} campaign=${campaignId} recipient=${recipientId}`);

    // The campaign may have stopped itself since this job was queued — a restricted
    // account or a disabled template fails identically for every recipient. One Redis
    // read is worth it to avoid working through the rest of the list.
    if (await this.isHalted(campaignId)) {
      this.logger.debug(`Campaign ${campaignId} is halted — leaving ${recipientId} pending`);
      return;
    }

    // Claim the recipient row atomically (prevent double-send)
    const claimed = await this.prisma.campaignContact.updateMany({
      where:  { id: recipientId, status: 'PENDING', claimedAt: null },
      data:   { status: 'SENDING', claimedAt: new Date() },
    });
    if (claimed.count === 0) {
      this.logger.debug(`Recipient ${recipientId} already claimed — skipping`);
      return;
    }

    try {
      // Fix #1: use cached campaign data — one DB read per campaign, not one per job
      const campaign = await this.getCampaignData(campaignId);
      if (!campaign || campaign.status === 'CANCELLED') {
        await this.prisma.campaignContact.update({
          where: { id: recipientId },
          data:  { status: 'CANCELLED' },
        });
        return;
      }

      const template = campaign.template;
      if (!template) throw new Error('Campaign has no template');

      const integration = campaign.whatsappIntegration
        ?? await this.prisma.whatsAppIntegration.findFirst({
            where: { businessId, isActive: true },
            select: { phoneNumberId: true, accessToken: true },
          });
      if (!integration?.accessToken) throw new Error('No active WhatsApp integration');
      const accessToken = decryptSecret(integration.accessToken);
      if (!accessToken) throw new Error('WhatsApp integration token could not be decrypted');

      const recipient = await this.prisma.campaignContact.findUnique({
        where: { id: recipientId },
      });
      if (!recipient) throw new Error('Recipient not found');

      // A person can opt out while the campaign is running — the webhook arrives in the
      // middle of a long send. Launch already filtered the list, so this catches only
      // those who changed their mind since, which is exactly the case worth catching.
      const blocked = await this.prisma.blacklistEntry.findFirst({
        where:  { phone: recipient.phone, OR: [{ tenantId }, { tenantId: null }] },
        select: { source: true },
      });
      if (blocked) {
        await this.skipRecipient(
          campaignId, recipientId, tenantId,
          blocked.source === 'OPT_OUT'
            ? 'Not sent: they turned off marketing messages before this reached them.'
            : 'Not sent: this number is on your do-not-contact list.',
        );
        return;
      }

      const variables = (recipient.variables as Record<string, string>) ?? {};

      const meta: Record<string, any> = (campaign.metadata as any) ?? {};

      // One builder for every template shape — carousel cards, dynamic URL buttons,
      // copy-code buttons and offer countdowns included.
      const components = buildSendComponents(toSpec(template), {
        variables,
        headerMediaId:  meta.headerMediaId  ?? variables['header_media_id']  ?? null,
        headerMediaUrl: meta.headerMediaUrl ?? variables['header_media_url'] ?? null,
        cardMedia:      Array.isArray(meta.cardMedia) ? meta.cardMedia : null,
        offerExpirationMs: meta.offerExpirationMs ? Number(meta.offerExpirationMs) : null,
        couponCode:     meta.couponCode ?? variables['coupon_code'] ?? null,
        location:       meta.location ?? null,
      });

      const ttlSeconds: number | undefined = meta.ttlSeconds ? Number(meta.ttlSeconds) : undefined;

      const msgBody: Record<string, unknown> = {
        messaging_product: 'whatsapp',
        to:                recipient.phone,
        type:              'template',
        ...(ttlSeconds && ttlSeconds > 0 && { validity_period: ttlSeconds }),
        template: {
          name:       template.name,
          language:   { code: template.language },
          components: components.length ? components : undefined,
        },
      };

      this.logger.log(`Meta API send → campaign=${campaignId} phone=${recipient.phone} template=${template.name}`);

      const res = await fetch(
        `https://graph.facebook.com/${WA_API_VERSION}/${integration.phoneNumberId}/messages`,
        {
          method:  'POST',
          headers: {
            Authorization:  `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(msgBody),
        },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        await this.handleSendFailure({
          job, campaignId, recipientId, tenantId, businessId,
          phone: recipient.phone,
          parsed: parseSendError(res.status, body),
        });
        return;
      }

      const json = await res.json() as any;
      const waMessageId: string | undefined = json?.messages?.[0]?.id;

      await this.prisma.campaignContact.update({
        where: { id: recipientId },
        data:  { status: 'SENT', waMessageId, sentAt: new Date() },
      });

      await this.prisma.campaign.update({
        where: { id: campaignId },
        data:  { sentCount: { increment: 1 } },
      });

      // Charge the wallet for the message just sent — failure is non-fatal (logged, not
      // re-thrown): the message is already with Meta, so a billing problem must not retry
      // the send. The price is this customer's own, falling back to its reseller's and
      // then the platform's (MessageRatesService).
      try {
        const priceMinor = await this.rates.priceFor(campaign.tenantId, campaign.template?.category);
        if (priceMinor > 0) {
          const movement = await this.wallet.debit(campaign.tenantId, priceMinor, {
            description:    `Campaign message: ${campaignId}`,
            referenceType: 'campaign_message',
            referenceId:   recipientId,
            idempotencyKey: `campaign-debit:${recipientId}`,
          });
          const charged = Math.abs(movement.appliedMinor);
          if (charged > 0) {
            await this.prisma.$transaction([
              this.prisma.campaignContact.update({ where: { id: recipientId }, data: { costMinor: charged } }),
              this.prisma.campaign.update({ where: { id: campaignId }, data: { costMinor: { increment: charged } } }),
            ]);
          }
          if (movement.shortfallMinor > 0) {
            this.logger.warn(
              `Wallet short by ${movement.shortfallMinor} paise for ${recipientId} (campaign ${campaignId}) — charged ${charged}`,
            );
          }
        }
      } catch (walletErr: any) {
        this.logger.warn(`Wallet debit skipped for ${recipientId}: ${walletErr.message}`);
      }

      this.logger.log(`Sent campaign=${campaignId} phone=${recipient.phone} waMessageId=${waMessageId}`);
      const completed = await this.tryComplete(campaignId, tenantId);
      if (completed) await this.progress.emitNow(campaignId); else this.progress.touch(campaignId);

    } catch (err: any) {
      // Something other than a rejection from Meta: a network blip, a missing
      // integration, a bug. Retryable until the queue gives up.
      this.logger.error(`Campaign send failed for recipient ${recipientId}: ${err.message}`);
      await this.failRecipient({
        campaignId, recipientId, tenantId,
        reason: String(err.message).slice(0, 500),
        errorCode: null, errorTitle: null,
        counter: 'failedCount',
        retryable: true, job,
      });
      if (this.hasAttemptsLeft(job)) throw err;
    }
  }

  // ── Failures from Meta ─────────────────────────────────────────────────────

  /**
   * One rejection from Meta, acted on according to what the code means.
   *
   * The old behaviour was to throw for everything, so the queue retried three times and
   * the recipient was counted failed on each attempt. That meant three more attempts at
   * someone who had opted out, and three attempts per recipient across the whole list
   * when the template itself was the problem.
   */
  private async handleSendFailure(ctx: {
    job: Job<CampaignSendJob>;
    campaignId: string;
    recipientId: string;
    tenantId: string;
    businessId: string;
    phone: string;
    parsed: ParsedSendError;
  }): Promise<void> {
    const { job, campaignId, recipientId, tenantId, businessId, phone, parsed } = ctx;
    const rule = classifySendError(parsed.code);
    const reason = describeSendError(parsed, rule);

    this.logger.warn(
      `Meta rejected campaign=${campaignId} recipient=${recipientId} ` +
      `code=${parsed.code ?? 'none'} http=${parsed.httpStatus} action=${rule.action}: ${parsed.message ?? ''}`,
    );

    if (rule.action === 'SUPPRESS') {
      // They have told WhatsApp to stop. Record it so no campaign targets them again.
      await this.suppression.suppress({ tenantId, businessId, phone, errorCode: parsed.code, reason: rule.reason });
    }

    if (rule.action === 'ABORT') {
      // Every remaining recipient would fail the same way.
      await this.haltCampaign(campaignId, tenantId, businessId, reason, parsed.code);
    }

    // 131049 is WhatsApp's own per-person marketing cap. The recipient did nothing
    // wrong and the send was never attempted, so it is a skip, not a failure.
    const isSkip = rule.action === 'SUPPRESS' || parsed.code === 131049;

    await this.failRecipient({
      campaignId, recipientId, tenantId,
      reason,
      errorCode: parsed.code,
      errorTitle: parsed.title,
      counter: isSkip ? 'skippedCount' : 'failedCount',
      retryable: rule.action === 'RETRY',
      job,
    });

    // Only a transient error goes back to the queue. Throwing is what triggers a retry.
    if (rule.action === 'RETRY' && this.hasAttemptsLeft(job)) {
      throw new Error(`${reason} — retrying`);
    }
  }

  /** Deliberately not sent to. Counted apart from a delivery that went wrong. */
  private async skipRecipient(
    campaignId: string, recipientId: string, tenantId: string, reason: string,
  ): Promise<void> {
    await this.prisma.campaignContact.update({
      where: { id: recipientId },
      data:  { status: 'FAILED', failedAt: new Date(), failedReason: reason },
    }).catch((err) => this.logger.error(`Could not skip ${recipientId}: ${err.message}`));

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data:  { skippedCount: { increment: 1 } },
    }).catch((err) => this.logger.error(`Could not count a skip on ${campaignId}: ${err.message}`));

    const completed = await this.tryComplete(campaignId, tenantId);
    if (completed) await this.progress.emitNow(campaignId); else this.progress.touch(campaignId);
  }

  /** Bull retries while attempts remain; the last one has to settle the row. */
  private hasAttemptsLeft(job: Job<CampaignSendJob>): boolean {
    const attempts = job.opts?.attempts ?? 1;
    return job.attemptsMade < attempts - 1;
  }

  /**
   * Settle the recipient row and move the campaign's counters once.
   *
   * A retryable failure leaves the row claimable again and touches no counter, so a
   * recipient that succeeds on the second attempt is never counted as failed. Only the
   * final attempt, or a verdict of no-retry, writes the terminal state.
   */
  private async failRecipient(args: {
    campaignId: string;
    recipientId: string;
    tenantId: string;
    reason: string;
    errorCode: number | null;
    errorTitle: string | null;
    counter: 'failedCount' | 'skippedCount';
    retryable: boolean;
    job: Job<CampaignSendJob>;
  }): Promise<void> {
    const { campaignId, recipientId, tenantId, reason, errorCode, errorTitle, counter, retryable, job } = args;

    if (retryable && this.hasAttemptsLeft(job)) {
      // Put it back so the retry can claim it, and record why it is being retried.
      await this.prisma.campaignContact.update({
        where: { id: recipientId },
        data:  { status: 'PENDING', claimedAt: null, failedReason: reason, errorCode, errorTitle },
      }).catch((err) => this.logger.error(`Could not release ${recipientId}: ${err.message}`));
      return;
    }

    await this.prisma.campaignContact.update({
      where: { id: recipientId },
      data:  { status: 'FAILED', failedAt: new Date(), failedReason: reason, errorCode, errorTitle },
    }).catch((err) => this.logger.error(`Could not fail ${recipientId}: ${err.message}`));

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data:  { [counter]: { increment: 1 }, lastError: reason.slice(0, 500) },
    }).catch((err) => this.logger.error(`Could not count ${counter} on ${campaignId}: ${err.message}`));

    const completed = await this.tryComplete(campaignId, tenantId);
    if (completed) await this.progress.emitNow(campaignId); else this.progress.touch(campaignId);
  }

  // ── Halting ────────────────────────────────────────────────────────────────

  private haltKey(campaignId: string): string {
    return `campaign:halted:${campaignId}`;
  }

  /**
   * Stop the campaign where it stands. Pending recipients stay pending, so resuming it
   * after fixing the cause picks up exactly where it left off rather than re-sending.
   *
   * The flag goes in Redis as well as the database because the campaign row is cached per
   * worker for 30 minutes, and waiting out that cache would mean thousands more doomed
   * sends. Every job checks the flag before claiming.
   */
  private async haltCampaign(
    campaignId: string, tenantId: string, businessId: string,
    reason: string, errorCode: number | null,
  ): Promise<void> {
    const halted = await this.prisma.campaign.updateMany({
      where: { id: campaignId, status: { in: ['RUNNING', 'PROCESSING'] } },
      data:  {
        status: 'PAUSED', haltedAt: new Date(), haltReason: reason.slice(0, 500),
        haltErrorCode: errorCode, lastError: reason.slice(0, 500),
      },
    });

    // Set the flag whether or not we were the one to pause it, so a worker holding a
    // stale cached row still stops.
    await this.redis.client.set(this.haltKey(campaignId), reason.slice(0, 500), 'EX', 24 * 60 * 60)
      .catch((err) => this.logger.error(`Could not flag halt for ${campaignId}: ${err.message}`));
    this.campaignCache.delete(campaignId);

    if (halted.count === 0) return; // already paused — only notify once

    const remaining = await this.prisma.campaignContact.count({
      where: { campaignId, status: 'PENDING' },
    });

    this.logger.error(`Campaign ${campaignId} halted (code ${errorCode ?? 'none'}): ${reason}`);

    void this.notifications.notify({
      tenantId,
      businessId,
      recipients: { roles: MANAGER_ROLES },
      type:  'SYSTEM',
      title: 'Campaign paused by WhatsApp',
      body:  `${reason} ${remaining.toLocaleString()} recipient${remaining === 1 ? '' : 's'} not sent. Fix the cause, then resume.`,
      href:  `/campaigns/${campaignId}`,
      data:  { campaignId, errorCode },
    });
    this.webhooks.dispatchEvent(tenantId, 'campaign.paused', { campaignId, reason, errorCode, remaining });
  }

  private async isHalted(campaignId: string): Promise<boolean> {
    try {
      return (await this.redis.client.exists(this.haltKey(campaignId))) === 1;
    } catch {
      // Redis is unreachable. The cached campaign status is the fallback.
      return false;
    }
  }

  // Fix #2: single atomic conditional UPDATE eliminates:
  //   - the extra findUnique on every job (was 1 lakh reads)
  //   - the race condition (concurrent workers both seeing "done" and firing the webhook twice)
  // Postgres guarantees only ONE concurrent UPDATE matches the WHERE clause
  // on the transition from RUNNING → COMPLETED, so the webhook fires exactly once.
  private async tryComplete(campaignId: string, tenantId: string): Promise<boolean> {
    // Prisma maps camelCase fields to quoted camelCase columns in Postgres (confirmed by migration SQL).
    // Skipped recipients count towards being done: they were deliberately not sent to,
    // so a campaign full of opt-outs still finishes instead of hanging at RUNNING.
    const rows = await this.prisma.$queryRaw<Array<{
      tenantId: string; businessId: string; name: string; sentCount: bigint; failedCount: bigint;
      skippedCount: bigint; deliveredCount: bigint; readCount: bigint; totalCount: bigint;
      completedAt: Date;
    }>>`
      UPDATE campaigns
      SET    status = 'COMPLETED', "completedAt" = NOW()
      WHERE  id     = ${campaignId}
        AND  status = 'RUNNING'
        AND  "sentCount" + "failedCount" + "skippedCount" >= "totalCount"
      RETURNING "tenantId", "businessId", "name", "sentCount", "failedCount", "skippedCount", "deliveredCount", "readCount", "totalCount", "completedAt"
    `;

    if (!rows.length) return false;

    this.campaignCache.delete(campaignId);

    const c = rows[0];
    void this.notifications.notify({
      tenantId:   c.tenantId ?? tenantId,
      businessId: c.businessId,
      recipients: { roles: MANAGER_ROLES },
      type:       'CAMPAIGN_COMPLETED',
      title:      `Campaign "${c.name}" finished`,
      body:       [
        `${Number(c.sentCount).toLocaleString()} sent`,
        `${Number(c.failedCount).toLocaleString()} failed`,
        ...(Number(c.skippedCount) > 0 ? [`${Number(c.skippedCount).toLocaleString()} skipped`] : []),
        `of ${Number(c.totalCount).toLocaleString()}`,
      ].join(' · '),
      href:       `/campaigns/${campaignId}`,
      data:       { campaignId },
    });
    this.webhooks.dispatchEvent(c.tenantId ?? tenantId, 'campaign.completed', {
      campaignId,
      sentCount:      Number(c.sentCount),
      failedCount:    Number(c.failedCount),
      deliveredCount: Number(c.deliveredCount),
      readCount:      Number(c.readCount),
      totalCount:     Number(c.totalCount),
      completedAt:    c.completedAt?.toISOString(),
    });
    return true;
  }
}
