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
  template:             { name: string; language: string; variables: any; headerType: string | null; headerContent: string | null; headerVariables: any[] } | null;
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
        template: {
          select: {
            name: true, language: true, variables: true,
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

      const components: unknown[] = [];
      if (template.headerType === 'TEXT' && template.headerContent) {
        const headerVars = (template.headerVariables ?? []).map((_, i) =>
          ({ type: 'text', text: variables[`header_${i + 1}`] ?? '' })
        );
        if (headerVars.length) components.push({ type: 'header', parameters: headerVars });
      }

      const bodyVars = (template.variables ?? []).map((_, i) =>
        ({ type: 'text', text: variables[`${i + 1}`] ?? '' })
      );
      if (bodyVars.length) components.push({ type: 'body', parameters: bodyVars });

      const msgBody: Record<string, unknown> = {
        messaging_product: 'whatsapp',
        to:                recipient.phone,
        type:              'template',
        template: {
          name:       template.name,
          language:   { code: template.language },
          components: components.length ? components : undefined,
        },
      };

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
        const err = await res.text();
        throw new Error(`Meta API error: ${err}`);
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

      this.logger.debug(`Sent campaign ${campaignId} to ${recipient.phone} (${waMessageId})`);
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
