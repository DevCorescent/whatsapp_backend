import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { PrismaService } from '@lib/prisma';
import { QUEUE_CAMPAIGN_SEND, CampaignSendJob } from '@lib/queue';

@Processor(QUEUE_CAMPAIGN_SEND)
export class CampaignSendProcessor {
  private readonly logger = new Logger(CampaignSendProcessor.name);

  constructor(private readonly prisma: PrismaService) {}

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
      // Load campaign + template + integration
      const campaign = await this.prisma.campaign.findUnique({
        where:   { id: campaignId },
        include: { template: true, whatsappIntegration: true },
      });
      if (!campaign || campaign.status === 'CANCELLED') {
        await this.prisma.campaignContact.update({
          where: { id: recipientId },
          data:  { status: 'CANCELLED' },
        });
        return;
      }

      const template = campaign.template;
      if (!template) throw new Error('Campaign has no template');

      // Resolve WhatsApp integration
      const integration = campaign.whatsappIntegration
        ?? await this.prisma.whatsAppIntegration.findFirst({
            where: { businessId, isActive: true },
          });
      if (!integration?.accessToken) throw new Error('No active WhatsApp integration');

      const recipient = await this.prisma.campaignContact.findUnique({
        where: { id: recipientId },
      });
      if (!recipient) throw new Error('Recipient not found');

      const variables = (recipient.variables as Record<string, string>) ?? {};

      // Build template message body for Meta API
      const components: unknown[] = [];
      if (template.headerType === 'TEXT' && template.headerContent) {
        const headerVars = (template.headerVariables ?? []).map((_, i) =>
          ({ type: 'text', text: variables[`header_${i + 1}`] ?? '' })
        );
        if (headerVars.length) {
          components.push({ type: 'header', parameters: headerVars });
        }
      }

      const bodyVars = (template.variables ?? []).map((_, i) =>
        ({ type: 'text', text: variables[`${i + 1}`] ?? '' })
      );
      if (bodyVars.length) {
        components.push({ type: 'body', parameters: bodyVars });
      }

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

      throw err; // Re-throw so BullMQ can retry
    }
  }
}
