import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { PrismaService } from '@lib/prisma';
import {
  WebhookDispatchService, NotificationsService, MessageRatesService, WalletService, MANAGER_ROLES, decryptSecret,
  buildSendComponents, toSpec,
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
        const errText = await res.text();
        this.logger.error(`Meta API ${res.status} for campaign=${campaignId} recipient=${recipientId}: ${errText}`);
        throw new Error(`Meta API error ${res.status}: ${errText}`);
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
      this.logger.error(`Campaign send failed for recipient ${recipientId}: ${err.message}`);

      await this.prisma.campaignContact.update({
        where: { id: recipientId },
        data:  { status: 'FAILED', failedAt: new Date(), failedReason: String(err.message).slice(0, 500) },
      });

      await this.prisma.campaign.update({
        where: { id: campaignId },
        data:  { failedCount: { increment: 1 } },
      });

      const completed = await this.tryComplete(campaignId, tenantId);
      if (completed) await this.progress.emitNow(campaignId); else this.progress.touch(campaignId);
      throw err;
    }
  }

  // Fix #2: single atomic conditional UPDATE eliminates:
  //   - the extra findUnique on every job (was 1 lakh reads)
  //   - the race condition (concurrent workers both seeing "done" and firing the webhook twice)
  // Postgres guarantees only ONE concurrent UPDATE matches the WHERE clause
  // on the transition from RUNNING → COMPLETED, so the webhook fires exactly once.
  private async tryComplete(campaignId: string, tenantId: string): Promise<boolean> {
    // Prisma maps camelCase fields to quoted camelCase columns in Postgres (confirmed by migration SQL).
    const rows = await this.prisma.$queryRaw<Array<{
      tenantId: string; businessId: string; name: string; sentCount: bigint; failedCount: bigint;
      deliveredCount: bigint; readCount: bigint; totalCount: bigint;
      completedAt: Date;
    }>>`
      UPDATE campaigns
      SET    status = 'COMPLETED', "completedAt" = NOW()
      WHERE  id     = ${campaignId}
        AND  status = 'RUNNING'
        AND  "sentCount" + "failedCount" >= "totalCount"
      RETURNING "tenantId", "businessId", "name", "sentCount", "failedCount", "deliveredCount", "readCount", "totalCount", "completedAt"
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
      body:       `${Number(c.sentCount).toLocaleString()} sent · ${Number(c.failedCount).toLocaleString()} failed of ${Number(c.totalCount).toLocaleString()}`,
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
