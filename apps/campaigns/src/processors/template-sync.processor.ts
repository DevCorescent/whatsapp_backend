import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { PrismaService } from '@lib/prisma';
import {
  buildCreatePayload, decryptSecret, pickTemplateAccount, toSpec, validateTemplate,
} from '@lib/common';
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

    // Submit through the account the template belongs to. Picking any connected number
    // would create the template in the wrong WhatsApp account, where no number the
    // workspace meant to send from can use it.
    const integration = pickTemplateAccount(
      await this.prisma.whatsAppIntegration.findMany({ where: { businessId, isActive: true } }),
      template.wabaId,
    );
    if (!integration?.accessToken) {
      const reason = template.wabaId
        ? "This template's WhatsApp account is no longer connected"
        : 'No WhatsApp number is connected to this workspace';
      await this.prisma.messageTemplate.update({
        where: { id: templateId },
        data:  { status: 'REJECTED', rejectionReason: reason },
      });
      this.logger.warn(`Template ${templateId} not submitted: ${reason}`);
      return;
    }

    const accessToken = decryptSecret(integration.accessToken);
    if (!accessToken) {
      this.logger.error(`Failed to decrypt access token for business ${businessId}`);
      return;
    }
    this.logger.log(`TemplateSyncProcessor templateId=${templateId} wabaId=${integration.whatsappBusinessId} tokenPrefix=${accessToken.slice(0, 8)}...`);

    // Refuse before spending a submission on something Meta would reject anyway.
    const spec = toSpec(template);
    const problems = validateTemplate(spec);
    if (problems.length) {
      await this.prisma.messageTemplate.update({
        where: { id: templateId },
        data:  { status: 'REJECTED', rejectionReason: problems.join(' ') },
      });
      this.logger.warn(`Template ${templateId} not submitted: ${problems.join(' ')}`);
      return;
    }

    try {
      const payload = buildCreatePayload(spec);

      const version = process.env.WHATSAPP_API_VERSION ?? 'v20.0';
      const res = await fetch(
        `https://graph.facebook.com/${version}/${integration.whatsappBusinessId}/message_templates`,
        {
          method:  'POST',
          headers: {
            Authorization:  `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
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
          // The account it now lives in, so it is only offered for numbers that can send it.
          wabaId:       integration.whatsappBusinessId,
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
