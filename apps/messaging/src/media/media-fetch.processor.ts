import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { PrismaService } from '@lib/prisma';
import { MessageEventsService, StorageService, decryptSecret, downloadMetaMedia } from '@lib/common';
import { QUEUE_MEDIA_FETCH } from '@lib/queue';

export interface MediaFetchJob {
  messageId:     string;
  tenantId:      string;
  businessId:    string;
  integrationId: string | null;
  mediaId:       string;
  mimeType?:     string;
  filename?:     string;
}

/** Copies inbound WhatsApp media into our storage before Meta's URL expires, then tells the inbox. */
@Processor(QUEUE_MEDIA_FETCH)
export class MediaFetchProcessor {
  private readonly logger = new Logger(MediaFetchProcessor.name);

  constructor(
    private readonly prisma:  PrismaService,
    private readonly storage: StorageService,
    private readonly events:  MessageEventsService,
  ) {}

  @Process({ concurrency: 4 })
  async handle(job: Job<MediaFetchJob>) {
    const { messageId, tenantId, businessId, integrationId, mediaId, mimeType, filename } = job.data;
    if (!this.storage.isConfigured()) return;

    const integration = integrationId
      ? await this.prisma.whatsAppIntegration.findUnique({ where: { id: integrationId } })
      : await this.prisma.whatsAppIntegration.findFirst({ where: { businessId, isActive: true }, orderBy: { isDefault: 'desc' } });
    const accessToken = integration?.accessToken ? decryptSecret(integration.accessToken) : null;
    if (!accessToken) throw new Error(`No usable access token for business ${businessId}`);

    const { buffer, info } = await downloadMetaMedia(mediaId, accessToken);
    const key = this.storage.mediaKey({ tenantId, businessId, id: messageId, mimeType: info.mimeType || mimeType, filename });
    const stored = await this.storage.put(key, buffer, info.mimeType || mimeType || 'application/octet-stream');

    const existing = await this.prisma.message.findUnique({ where: { id: messageId }, select: { metadata: true } });
    const metadata = { ...((existing?.metadata as Record<string, unknown> | null) ?? {}), storageKey: key };

    await this.prisma.message.update({
      where: { id: messageId },
      data:  { mediaUrl: stored.url, mediaSize: info.size, mediaMimeType: info.mimeType || mimeType, metadata: metadata as any },
    });
    this.logger.log(`Stored media for message ${messageId} → ${key} (${info.size ?? buffer.byteLength} bytes)`);

    void this.events.messageUpdated(messageId, { mediaUrl: stored.url, mediaSize: info.size, mediaMimeType: info.mimeType });
  }
}
