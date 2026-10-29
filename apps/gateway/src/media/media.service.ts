import 'multer';
import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import {
  TenantScope, StorageService, decryptSecret, downloadMetaMedia, lookupMetaMedia, WA_API_VERSION,
} from '@lib/common';

export interface UploadedMedia {
  /** Public storage URL when storage is configured with a public base; otherwise null. */
  url: string | null;
  storageKey: string | null;
  filename: string;
  mimeType: string;
  size: number;
  category: 'image' | 'video' | 'audio' | 'document';
  /** Meta media id — what the send call references. */
  mediaId: string;
}

export type MediaSource =
  | { kind: 'redirect'; url: string }
  | { kind: 'bytes'; buffer: Buffer; contentType: string; filename?: string | null };

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma:  PrismaService,
    private readonly storage: StorageService,
  ) {}

  private async integrationFor(businessId: string, integrationId?: string | null) {
    const integration = integrationId
      ? await this.prisma.whatsAppIntegration.findFirst({ where: { id: integrationId, businessId } })
      : await this.prisma.whatsAppIntegration.findFirst({
          where: { businessId, isActive: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        });
    if (!integration) throw new NotFoundException('No active WhatsApp integration found');
    const accessToken = integration.accessToken ? decryptSecret(integration.accessToken) : null;
    if (!accessToken) throw new BadRequestException('WhatsApp integration access token is missing or cannot be decrypted');
    return { integration, accessToken };
  }

  private category(mimeType: string): UploadedMedia['category'] {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'document';
  }

  private async uploadToMeta(phoneNumberId: string, accessToken: string, buffer: Buffer, filename: string, mimeType: string) {
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);
    formData.append('type', mimeType);
    formData.append('messaging_product', 'whatsapp');

    const response = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/media`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body:    formData,
    });
    if (!response.ok) {
      const err = await response.text();
      this.logger.error(`Meta upload failed ${response.status}: ${err.slice(0, 300)}`);
      throw new BadRequestException(`Meta upload failed: ${err.slice(0, 200)}`);
    }
    return ((await response.json()) as { id: string }).id;
  }

  /** Uploads to Meta (for sending) and, when configured, to our storage (for viewing later). */
  private async storeOne(scope: TenantScope, phoneNumberId: string, accessToken: string, buffer: Buffer, filename: string, mimeType: string): Promise<UploadedMedia> {
    const mediaId = await this.uploadToMeta(phoneNumberId, accessToken, buffer, filename, mimeType);

    let url: string | null = null;
    let storageKey: string | null = null;
    if (this.storage.isConfigured()) {
      try {
        const key = this.storage.mediaKey({ tenantId: scope.tenantId, businessId: scope.businessId, id: `out-${mediaId}`, mimeType, filename });
        const stored = await this.storage.put(key, buffer, mimeType);
        url = stored.url;
        storageKey = stored.key;
      } catch (err: any) {
        this.logger.warn(`Storage put failed for upload ${filename}: ${err?.message ?? err}`);
      }
    }

    return { url, storageKey, filename, mimeType, size: buffer.byteLength, category: this.category(mimeType), mediaId };
  }

  async uploadMedia(scope: TenantScope, body: { base64: string; filename: string; mimeType: string }) {
    const { integration, accessToken } = await this.integrationFor(scope.businessId);
    const buffer = Buffer.from(body.base64, 'base64');
    const item = await this.storeOne(scope, integration.phoneNumberId, accessToken, buffer, body.filename, body.mimeType);
    return { success: true, data: [item] };
  }

  async uploadFiles(scope: TenantScope, files: Express.Multer.File[]) {
    const { integration, accessToken } = await this.integrationFor(scope.businessId);
    const results = await Promise.allSettled(
      files.map(f => this.storeOne(scope, integration.phoneNumberId, accessToken, f.buffer, f.originalname, f.mimetype)),
    );
    const data = results.filter((r): r is PromiseFulfilledResult<UploadedMedia> => r.status === 'fulfilled').map(r => r.value);
    const failed = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    if (data.length === 0 && failed.length) {
      throw failed[0].reason instanceof Error ? failed[0].reason : new BadRequestException('Upload failed');
    }
    return { success: true, data };
  }

  /**
   * Where the bytes for a message's attachment live right now: our storage (public URL or a
   * presigned one) when the copy exists, otherwise a live stream from Meta by media id.
   */
  async sourceForMessage(scope: TenantScope, messageId: string): Promise<MediaSource> {
    const message = await this.prisma.message.findFirst({
      where:   { id: messageId, tenantId: scope.tenantId, businessId: scope.businessId },
      select:  { mediaUrl: true, mediaMimeType: true, metadata: true, conversation: { select: { whatsappIntegrationId: true } } },
    });
    if (!message) throw new NotFoundException('Message not found');

    const meta = (message.metadata as Record<string, unknown> | null) ?? {};
    const storageKey = typeof meta.storageKey === 'string' ? meta.storageKey : null;
    if (message.mediaUrl && /^https?:\/\//.test(message.mediaUrl) && !message.mediaUrl.includes('graph.facebook.com')) {
      return { kind: 'redirect', url: message.mediaUrl };
    }
    if (storageKey && this.storage.isConfigured()) {
      return { kind: 'redirect', url: await this.storage.presignGet(storageKey) };
    }

    const mediaId = typeof meta.mediaId === 'string' ? meta.mediaId : null;
    if (!mediaId) throw new NotFoundException('This message has no media');

    const { accessToken } = await this.integrationFor(scope.businessId, message.conversation?.whatsappIntegrationId);
    const { buffer, info } = await downloadMetaMedia(mediaId, accessToken);
    return {
      kind: 'bytes', buffer,
      contentType: info.mimeType || message.mediaMimeType || 'application/octet-stream',
      filename: typeof meta.filename === 'string' ? meta.filename : null,
    };
  }

  /** Raw Meta media by id (legacy proxy); scoped to the business's default integration. */
  async proxyMedia(scope: TenantScope, mediaId: string): Promise<{ buffer: Buffer; contentType: string }> {
    const { accessToken } = await this.integrationFor(scope.businessId);
    await lookupMetaMedia(mediaId, accessToken).catch(() => { throw new NotFoundException('Media not found on Meta'); });
    const { buffer, info } = await downloadMetaMedia(mediaId, accessToken);
    return { buffer, contentType: info.mimeType };
  }
}
