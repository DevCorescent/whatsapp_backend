import 'multer';
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { ConfigService } from '@nestjs/config';
import { TenantScope } from '@lib/common';

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get apiVersion(): string {
    return this.config.get<string>('WHATSAPP_API_VERSION') ?? 'v18.0';
  }

  private async getIntegration(businessId: string) {
    const integration = await this.prisma.whatsAppIntegration.findFirst({
      where: { businessId, isDefault: true, isActive: true },
    });
    if (!integration) throw new NotFoundException('No active default WhatsApp integration found');
    return integration;
  }

  private getCategory(mimeType: string): string {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'document';
  }

  private async uploadOneFile(
    phoneNumberId: string,
    accessToken: string,
    buffer: Buffer,
    filename: string,
    mimeType: string,
  ) {
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
    formData.append('file', blob, filename);
    formData.append('type', mimeType);
    formData.append('messaging_product', 'whatsapp');

    const response = await fetch(
      `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}/media`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body:    formData,
      },
    );

    if (!response.ok) {
      const err = await response.text();
      throw new BadRequestException(`Meta upload failed: ${err}`);
    }

    const data = (await response.json()) as { id: string };
    return data.id;
  }

  // JSON upload (single file as base64)
  async uploadMedia(scope: TenantScope, body: { base64: string; filename: string; mimeType: string }) {
    const integration = await this.getIntegration(scope.businessId);
    if (!integration.accessToken) throw new BadRequestException('Integration has no access token');

    const { phoneNumberId, accessToken } = integration;
    const buffer = Buffer.from(body.base64, 'base64');

    const mediaId = await this.uploadOneFile(phoneNumberId, accessToken, buffer, body.filename, body.mimeType);
    const url = `https://graph.facebook.com/${this.apiVersion}/${mediaId}`;

    return {
      success: true,
      data: [{
        url,
        filename: body.filename,
        mimeType: body.mimeType,
        size:     buffer.byteLength,
        category: this.getCategory(body.mimeType),
        mediaId,
      }],
    };
  }

  // Multipart upload (multiple files)
  async uploadFiles(
    scope: TenantScope,
    files: Express.Multer.File[],
  ) {
    const integration = await this.getIntegration(scope.businessId);
    if (!integration.accessToken) throw new BadRequestException('Integration has no access token');

    const { phoneNumberId, accessToken } = integration;
    const results = await Promise.allSettled(
      files.map(async (f) => {
        const mediaId = await this.uploadOneFile(
          phoneNumberId, accessToken, f.buffer, f.originalname, f.mimetype,
        );
        const url = `https://graph.facebook.com/${this.apiVersion}/${mediaId}`;
        return {
          url,
          filename: f.originalname,
          mimeType: f.mimetype,
          size:     f.size,
          category: this.getCategory(f.mimetype),
          mediaId,
        };
      }),
    );

    const data = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map((r) => r.value);

    return { success: true, data };
  }

  async proxyMedia(scope: TenantScope, mediaId: string): Promise<{ buffer: Buffer; contentType: string }> {
    const integration = await this.getIntegration(scope.businessId);
    if (!integration.accessToken) throw new BadRequestException('Integration has no access token');

    const { accessToken } = integration;

    // Step 1: get CDN URL from Meta
    const metaRes = await fetch(
      `https://graph.facebook.com/${this.apiVersion}/${mediaId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!metaRes.ok) throw new NotFoundException('Media not found on Meta');
    const meta = (await metaRes.json()) as { url: string; mime_type: string };

    // Step 2: download actual bytes from CDN URL
    const fileRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!fileRes.ok) throw new NotFoundException('Failed to fetch media bytes');

    const arrayBuffer = await fileRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = meta.mime_type ?? 'application/octet-stream';
    return { buffer, contentType };
  }

  serveMedia() {
    return { message: 'Use S3 presigned URLs for file serving' };
  }
}
