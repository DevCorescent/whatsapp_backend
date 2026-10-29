import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { PrismaService } from '@lib/prisma';
import { decryptSecret } from '@lib/common';
import { QUEUE_TEMPLATE_SYNC } from '@lib/queue';

interface TemplateSyncJob {
  tenantId:   string;
  businessId: string;
  templateId: string;
}

@Processor(QUEUE_TEMPLATE_SYNC)
export class TemplateSyncProcessor {
  private readonly logger = new Logger(TemplateSyncProcessor.name);

  constructor(private readonly prisma: PrismaService) {}

  @Process({ concurrency: 3 })
  async handle(job: Job<TemplateSyncJob>) {
    const { templateId, businessId } = job.data;

    const template = await this.prisma.messageTemplate.findUnique({ where: { id: templateId } });
    if (!template) return;

    const integration = await this.prisma.whatsAppIntegration.findFirst({
      where: { businessId, isActive: true },
    });
    if (!integration?.accessToken) {
      this.logger.warn(`No active integration for business ${businessId}, skipping template sync`);
      return;
    }

    const accessToken = decryptSecret(integration.accessToken);
    if (!accessToken) {
      this.logger.error(`Failed to decrypt access token for business ${businessId}`);
      return;
    }
    this.logger.log(`TemplateSyncProcessor templateId=${templateId} wabaId=${integration.whatsappBusinessId} tokenPrefix=${accessToken.slice(0, 8)}...`);

    try {
      const components: unknown[] = [];

      if (template.headerType && template.headerContent) {
        components.push({
          type:   'HEADER',
          format: template.headerType,
          text:   template.headerType === 'TEXT' ? template.headerContent : undefined,
        });
      }

      components.push({ type: 'BODY', text: template.body });

      if (template.footer) {
        components.push({ type: 'FOOTER', text: template.footer });
      }

      const buttons = template.buttons as any[];
      if (buttons?.length) {
        components.push({ type: 'BUTTONS', buttons });
      }

      const version = process.env.WHATSAPP_API_VERSION ?? 'v20.0';
      const res = await fetch(
        `https://graph.facebook.com/${version}/${integration.whatsappBusinessId}/message_templates`,
        {
          method:  'POST',
          headers: {
            Authorization:  `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name:       template.name,
            category:   template.category.toUpperCase(),
            language:   template.language,
            components,
          }),
        },
      );

      const json = await res.json() as any;
      this.logger.log(`TemplateSyncProcessor ← status=${res.status} waTemplateId=${json?.id} metaStatus=${json?.status} error=${JSON.stringify(json?.error ?? null)}`);

      if (!res.ok) {
        const reason = json?.error?.message ?? 'Unknown Meta error';
        await this.prisma.messageTemplate.update({
          where: { id: templateId },
          data:  { status: 'REJECTED', rejectionReason: reason },
        });
        this.logger.error(`Template ${templateId} rejected: ${reason}`);
        return;
      }

      await this.prisma.messageTemplate.update({
        where: { id: templateId },
        data:  {
          waTemplateId: json.id,
          status:       json.status ?? 'PENDING',
          lastSyncedAt: new Date(),
        },
      });

      this.logger.debug(`Template ${templateId} submitted: waId=${json.id} status=${json.status}`);
    } catch (err: any) {
      this.logger.error(`Template sync error for ${templateId}: ${err.message}`);
      throw err;
    }
  }
}
