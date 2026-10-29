import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface StoredObject {
  key: string;
  /** Public URL when STORAGE_PUBLIC_URL is set; otherwise null and readers presign on demand. */
  url: string | null;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr',
  'application/pdf': 'pdf', 'text/plain': 'txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
};

/**
 * S3-compatible object storage (AWS S3, Cloudflare R2, Supabase, MinIO) for chat media.
 * Unconfigured is a supported state: callers check `isConfigured()` and fall back to
 * streaming from Meta.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client | null;
  private readonly bucket: string;
  private readonly publicUrl: string | null;

  constructor(cfg: ConfigService) {
    const endpoint  = cfg.get<string>('STORAGE_ENDPOINT') || undefined;
    const region    = cfg.get<string>('STORAGE_REGION') || 'auto';
    const accessKey = cfg.get<string>('STORAGE_ACCESS_KEY') || '';
    const secretKey = cfg.get<string>('STORAGE_SECRET_KEY') || '';
    this.bucket     = cfg.get<string>('STORAGE_BUCKET') || '';
    this.publicUrl  = (cfg.get<string>('STORAGE_PUBLIC_URL') || '').replace(/\/+$/, '') || null;

    if (this.bucket && accessKey && secretKey) {
      this.client = new S3Client({
        endpoint, region,
        forcePathStyle: Boolean(endpoint),
        credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      });
      this.logger.log(`Storage enabled bucket=${this.bucket} endpoint=${endpoint ?? 'aws'} public=${this.publicUrl ? 'yes' : 'presigned'}`);
    } else {
      this.client = null;
      this.logger.warn('Storage not configured (STORAGE_BUCKET/ACCESS_KEY/SECRET_KEY) — media will stream from Meta');
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  mediaKey(parts: { tenantId: string; businessId: string; id: string; mimeType?: string | null; filename?: string | null }): string {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm   = String(now.getUTCMonth() + 1).padStart(2, '0');
    const ext  = extensionFor(parts.mimeType, parts.filename);
    return `tenants/${parts.tenantId}/businesses/${parts.businessId}/media/${yyyy}/${mm}/${parts.id}${ext ? `.${ext}` : ''}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    if (!this.client) throw new Error('Storage not configured');
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: body, ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    return { key, url: this.publicUrl ? `${this.publicUrl}/${key}` : null };
  }

  async presignGet(key: string, expiresInSec = 3600): Promise<string> {
    if (!this.client) throw new Error('Storage not configured');
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresInSec });
  }
}

function extensionFor(mimeType?: string | null, filename?: string | null): string {
  const fromName = filename?.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  if (fromName && /^[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  const base = (mimeType ?? '').split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[base] ?? '';
}
