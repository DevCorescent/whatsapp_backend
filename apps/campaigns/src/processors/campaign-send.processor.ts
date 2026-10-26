import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { PrismaService } from '@lib/prisma';
import { WebhookDispatchService } from '@lib/common';
import { QUEUE_CAMPAIGN_SEND, CampaignSendJob } from '@lib/queue';

// Shape cached per campaign — only immutable fields (template, integration credentials)
interface CampaignData {
  id:                   string;
  status:               string;
  tenantId:             string;
  totalCount:           number;
  metadata:             any;
  template:             { name: string; language: string; category: string; variables: any; headerType: string | null; headerContent: string | null; headerVariables: any[] } | null;
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
  ) {}

  private async getCampaignData(campaignId: string): Promise<CampaignData | null> {
    const cached = this.campaignCache.get(campaignId);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const campaign = await this.prisma.campaign.findUnique({
      where:   { id: campaignId },
      select: {
        id: true, status: true, tenantId: true, totalCount: true, businessId: true,
        metadata: true,
        template: {
          select: {
            name: true, language: true, category: true, variables: true,
            headerType: true, headerContent: true, headerVariables: true,
          },
        },
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

      const recipient = await this.prisma.campaignContact.findUnique({
        where: { id: recipientId },
      });
      if (!recipient) throw new Error('Recipient not found');

      const variables = (recipient.variables as Record<string, string>) ?? {};

      const meta: Record<string, any> = (campaign.metadata as any) ?? {};
      const components: unknown[] = [];

      // Header component: media (IMAGE/VIDEO/DOCUMENT) or text variables
      if (template.headerType === 'IMAGE' || template.headerType === 'VIDEO' || template.headerType === 'DOCUMENT') {
        const mediaId  = meta.headerMediaId  ?? variables['header_media_id']  ?? null;
        const mediaUrl = meta.headerMediaUrl ?? variables['header_media_url'] ?? null;
        if (mediaId || mediaUrl) {
          const mediaType = template.headerType.toLowerCase() as 'image' | 'video' | 'document';
          components.push({
            type:       'header',
            parameters: [{ type: mediaType, [mediaType]: mediaId ? { id: mediaId } : { link: mediaUrl } }],
          });
        }
      } else if (template.headerType === 'TEXT' && template.headerContent) {
        const headerVars = (template.headerVariables ?? []).map((_, i) =>
          ({ type: 'text', text: variables[`header_${i + 1}`] ?? '' })
        );
        if (headerVars.length) components.push({ type: 'header', parameters: headerVars });
      }

      const bodyVars = (template.variables ?? []).map((_, i) =>
        ({ type: 'text', text: variables[`${i + 1}`] ?? '' })
      );
      if (bodyVars.length) components.push({ type: 'body', parameters: bodyVars });

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
        `https://graph.facebook.com/v20.0/${integration.phoneNumberId}/messages`,
        {
          method:  'POST',
          headers: {
            Authorization:  `Bearer ${integration.accessToken}`,
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

      // Debit wallet per message sent — failure is non-fatal (logged, not re-thrown)
      try {
        const tmplCategory = campaign.template?.category ?? '';
        const upper        = tmplCategory.toUpperCase();
        const rateCategory = upper.includes('MARKETING')   ? 'WA_MARKETING'
                           : upper.includes('UTILITY')     ? 'WA_UTILITY'
                           : upper.includes('AUTH')        ? 'WA_AUTHENTICATION'
                           : null;

        if (rateCategory) {
          const rate = await this.prisma.messageRate.findFirst({
            where:  { category: rateCategory as any, resellerId: null },
            select: { priceMinor: true },
          });
          const priceMinor = rate?.priceMinor ?? 0;

          if (priceMinor > 0) {
            await this.prisma.$transaction(async (tx) => {
              const wallet       = await tx.wallet.findUnique({
                where:  { tenantId: campaign.tenantId },
                select: { balanceMinor: true },
              });
              const newBalance = (wallet?.balanceMinor ?? 0) - priceMinor;

              await tx.walletTransaction.create({
                data: {
                  tenantId:         campaign.tenantId,
                  type:             'DEBIT',
                  amountMinor:      priceMinor,
                  balanceAfterMinor: newBalance,
                  description:      `Campaign message: ${campaignId}`,
                  idempotencyKey:   `campaign-debit:${recipientId}`,
                },
              });

              await tx.wallet.update({
                where: { tenantId: campaign.tenantId },
                data:  { balanceMinor: { decrement: priceMinor } },
              });

              await tx.campaignContact.update({
                where: { id: recipientId },
                data:  { costMinor: priceMinor },
              });

              await tx.campaign.update({
                where: { id: campaignId },
                data:  { costMinor: { increment: priceMinor } },
              });
            });
          }
        }
      } catch (walletErr: any) {
        this.logger.warn(`Wallet debit skipped for ${recipientId}: ${walletErr.message}`);
      }

      this.logger.log(`Sent campaign=${campaignId} phone=${recipient.phone} waMessageId=${waMessageId}`);
      await this.tryComplete(campaignId, tenantId);

    } catch (err: any) {
      this.logger.error(`Campaign send failed for recipient ${recipientId}: ${err.message}`);

      await this.prisma.campaignContact.update({
        where: { id: recipientId },
        data:  { status: 'FAILED', failedReason: String(err.message).slice(0, 500) },
      });

      await this.prisma.campaign.update({
        where: { id: campaignId },
        data:  { failedCount: { increment: 1 } },
      });

      await this.tryComplete(campaignId, tenantId);
      throw err;
    }
  }

  // Fix #2: single atomic conditional UPDATE eliminates:
  //   - the extra findUnique on every job (was 1 lakh reads)
  //   - the race condition (concurrent workers both seeing "done" and firing the webhook twice)
  // Postgres guarantees only ONE concurrent UPDATE matches the WHERE clause
  // on the transition from RUNNING → COMPLETED, so the webhook fires exactly once.
  private async tryComplete(campaignId: string, tenantId: string): Promise<void> {
    // Prisma maps camelCase fields to quoted camelCase columns in Postgres (confirmed by migration SQL).
    const rows = await this.prisma.$queryRaw<Array<{
      tenantId: string; sentCount: bigint; failedCount: bigint;
      deliveredCount: bigint; readCount: bigint; totalCount: bigint;
      completedAt: Date;
    }>>`
      UPDATE campaigns
      SET    status = 'COMPLETED', "completedAt" = NOW()
      WHERE  id     = ${campaignId}
        AND  status = 'RUNNING'
        AND  "sentCount" + "failedCount" >= "totalCount"
      RETURNING "tenantId", "sentCount", "failedCount", "deliveredCount", "readCount", "totalCount", "completedAt"
    `;

    if (!rows.length) return;

    this.campaignCache.delete(campaignId);

    const c = rows[0];
    this.webhooks.dispatchEvent(c.tenantId ?? tenantId, 'campaign.completed', {
      campaignId,
      sentCount:      Number(c.sentCount),
      failedCount:    Number(c.failedCount),
      deliveredCount: Number(c.deliveredCount),
      readCount:      Number(c.readCount),
      totalCount:     Number(c.totalCount),
      completedAt:    c.completedAt?.toISOString(),
    });
  }
}
