import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import * as crypto from 'crypto';
import { PrismaService } from '@lib/prisma';
import { QUEUE_INBOUND_MESSAGE } from '@lib/queue';
import type { WAChangeValue, WAMessage, WAStatus, WAContact } from './webhook.types';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg:    ConfigService,
    @InjectQueue(QUEUE_INBOUND_MESSAGE) private readonly inboundQueue: Queue,
  ) {}

  // ── Signature verification ────────────────────────────────────────────────

  verifySignature(rawBody: Buffer, signature: string | null, appSecret: string): boolean {
    if (!signature) return false;
    const parts = signature.split('=');
    if (parts[0] !== 'sha256' || !parts[1]) return false;
    const expected = crypto
      .createHmac('sha256', appSecret)
      .update(rawBody)
      .digest('hex');
    try {
      return crypto.timingSafeEqual(
        Buffer.from(parts[1], 'hex'),
        Buffer.from(expected, 'hex'),
      );
    } catch {
      return false;
    }
  }

  extractPhoneNumberId(rawBody: string): string | null {
    try {
      const quick = JSON.parse(rawBody);
      return quick?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id ?? null;
    } catch {
      return null;
    }
  }

  async resolveAppSecret(phoneNumberId: string | null): Promise<string> {
    if (phoneNumberId) {
      const integration = await this.prisma.whatsAppIntegration.findUnique({
        where:  { phoneNumberId },
        select: { appSecret: true, business: { select: { whatsappAppSecret: true } } },
      }).catch(() => null);

      if (integration?.appSecret) return this.decrypt(integration.appSecret);
      if (integration?.business?.whatsappAppSecret) return this.decrypt(integration.business.whatsappAppSecret);
    }

    return this.cfg.get<string>('WHATSAPP_APP_SECRET', '');
  }

  private decrypt(value: string): string {
    // Mirror lib/crypto.ts from Next.js — if not encrypted just return raw
    if (!value.includes(':')) return value;
    try {
      const key = this.cfg.getOrThrow<string>('ENCRYPTION_KEY');
      const [ivHex, encrypted] = value.split(':');
      const decipher = crypto.createDecipheriv(
        'aes-256-cbc',
        Buffer.from(key, 'hex'),
        Buffer.from(ivHex, 'hex'),
      );
      return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
    } catch {
      return value;
    }
  }

  // ── Tenant resolution ─────────────────────────────────────────────────────

  async resolveTenant(phoneNumberId: string) {
    const integration = await this.prisma.whatsAppIntegration.findUnique({
      where:  { phoneNumberId },
      select: {
        id:         true,
        tenantId:   true,
        businessId: true,
      },
    });
    if (!integration) return null;
    return {
      tenantId:              integration.tenantId,
      businessId:            integration.businessId,
      whatsappIntegrationId: integration.id,
      phoneNumberId,
    };
  }

  // ── Change value processing ───────────────────────────────────────────────

  async processChangeValue(value: WAChangeValue): Promise<void> {
    const phoneNumberId = value.metadata?.phone_number_id;
    if (!phoneNumberId) return;

    const identity = await this.resolveTenant(phoneNumberId);
    if (!identity) {
      this.logger.warn(`No integration found for phone_number_id=${phoneNumberId}`);
      return;
    }

    const contacts = value.contacts ?? [];

    // Process messages — sequential to preserve order
    for (const message of value.messages ?? []) {
      await this.dispatchInboundMessage(identity, message, contacts).catch(err =>
        this.logger.error(`Failed to dispatch message ${message.id}`, err),
      );
    }

    // Process delivery statuses — sequential
    for (const status of value.statuses ?? []) {
      await this.processStatus(identity.tenantId, status).catch(err =>
        this.logger.error(`Failed to process status ${status.id}`, err),
      );
    }
  }

  // ── Queue dispatch ─────────────────────────────────────────────────────────

  private async dispatchInboundMessage(
    identity: { tenantId: string; businessId: string; phoneNumberId: string; whatsappIntegrationId: string },
    message: WAMessage,
    contacts: WAContact[],
  ): Promise<void> {
    const contact = contacts.find(c => c.wa_id === message.from) ?? contacts[0];
    const contactName  = contact?.profile?.name;
    const contactWaId  = contact?.bsuid ?? contact?.username ?? contact?.wa_id ?? message.from;

    await this.inboundQueue.add(
      {
        tenantId:              identity.tenantId,
        businessId:            identity.businessId,
        phoneNumberId:         identity.phoneNumberId,
        whatsappIntegrationId: identity.whatsappIntegrationId,
        waMessageId:           message.id,
        from:                  message.from,
        contactName,
        contactWaId,
        type:                  message.type,
        content:               this.extractContent(message),
        timestamp:             message.timestamp,
        rawMessage:            message,
      },
      {
        attempts:    3,
        backoff:     { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
      },
    );
  }

  private extractContent(message: WAMessage): string {
    switch (message.type) {
      case 'text':        return message.text?.body ?? '';
      case 'image':       return message.image?.caption ?? '[image]';
      case 'video':       return message.video?.caption ?? '[video]';
      case 'audio':       return '[audio]';
      case 'document':    return message.document?.caption ?? message.document?.filename ?? '[document]';
      case 'sticker':     return '[sticker]';
      case 'location':    return `[location: ${message.location?.name ?? `${message.location?.latitude},${message.location?.longitude}`}]`;
      case 'interactive': return message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? '[interactive]';
      case 'button':      return message.button?.text ?? '[button]';
      case 'reaction':    return `[reaction: ${message.reaction?.emoji}]`;
      default:            return `[${message.type}]`;
    }
  }

  // ── Status processing ─────────────────────────────────────────────────────

  private readonly STATUS_RANK: Record<string, number> = {
    pending: 0, sent: 1, delivered: 2, read: 3, failed: 4,
  };

  private async processStatus(tenantId: string, status: WAStatus): Promise<void> {
    const rank = this.STATUS_RANK[status.status] ?? -1;
    if (rank < 0) return;

    await this.prisma.message.updateMany({
      where: {
        waMessageId: status.id,
        tenantId,
        // Only advance forward (monotonic status)
        statusRank: { lt: rank },
      },
      data: {
        status:     status.status.toUpperCase() as any,
        statusRank: rank,
        ...(status.status === 'delivered' ? { deliveredAt: new Date() } : {}),
        ...(status.status === 'read'      ? { readAt:      new Date() } : {}),
        ...(status.status === 'failed'    ? { failedAt:    new Date() } : {}),
      },
    }).catch(() => {
      // message may not exist (outbound from a different channel) — ignore
    });
  }
}
