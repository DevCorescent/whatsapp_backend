import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import * as crypto from 'crypto';
import { PrismaService } from '@lib/prisma';
import { WebhookDispatchService, decryptSecret } from '@lib/common';
import { QUEUE_INBOUND_MESSAGE } from '@lib/queue';
import { StatusBufferService } from './status-buffer.service';
import type { WAChangeValue, WAMessage, WAStatus, WAContact } from './webhook.types';

// Fix #3: cache per-phone-number integration row — merges the two separate
// DB reads (resolveAppSecret + resolveTenant) that previously ran on every webhook.
interface IntegrationRow {
  id:                  string;
  tenantId:            string;
  businessId:          string;
  appSecret:           string | null;
  business:            { whatsappAppSecret: string | null } | null;
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  private readonly integrationCache = new Map<string, { data: IntegrationRow; expiresAt: number }>();
  private readonly INTEGRATION_TTL_MS = 5 * 60 * 1_000;

  constructor(
    private readonly prisma:        PrismaService,
    private readonly cfg:           ConfigService,
    private readonly webhooks:      WebhookDispatchService,
    private readonly statusBuffer:  StatusBufferService,
    @InjectQueue(QUEUE_INBOUND_MESSAGE) private readonly inboundQueue: Queue,
  ) {}

  // ── Integration cache — one DB read per phone number per 5 min ───────────

  private async getIntegration(phoneNumberId: string): Promise<IntegrationRow | null> {
    const cached = this.integrationCache.get(phoneNumberId);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const row = await this.prisma.whatsAppIntegration.findUnique({
      where:  { phoneNumberId },
      select: {
        id: true, tenantId: true, businessId: true, appSecret: true,
        business: { select: { whatsappAppSecret: true } },
      },
    }).catch(() => null);

    if (!row) return null;
    this.integrationCache.set(phoneNumberId, { data: row, expiresAt: Date.now() + this.INTEGRATION_TTL_MS });
    return row;
  }

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
      const integration = await this.getIntegration(phoneNumberId);
      if (integration?.appSecret) {
        const plain = decryptSecret(integration.appSecret);
        if (plain) return plain;
      }
      if (integration?.business?.whatsappAppSecret) {
        const plain = decryptSecret(integration.business.whatsappAppSecret);
        if (plain) return plain;
      }
    }
    return this.cfg.get<string>('WHATSAPP_APP_SECRET', '');
  }

  // ── Tenant resolution ─────────────────────────────────────────────────────

  async resolveTenant(phoneNumberId: string) {
    // Primary: WhatsAppIntegration row (numbers connected through settings)
    const integration = await this.getIntegration(phoneNumberId);
    if (integration) {
      this.logger.log(`resolveTenant: via WhatsAppIntegration tenantId=${integration.tenantId}`);
      return {
        tenantId:              integration.tenantId,
        businessId:            integration.businessId,
        whatsappIntegrationId: integration.id,
        phoneNumberId,
      };
    }

    // Fallback: legacy Business.whatsappPhoneNumberId (numbers stored on the business row)
    const biz = await this.prisma.business.findFirst({
      where:  { whatsappPhoneNumberId: phoneNumberId },
      select: { id: true, tenantId: true },
    }).catch(() => null);

    if (biz) {
      this.logger.log(`resolveTenant: via Business fallback tenantId=${biz.tenantId}`);
      return {
        tenantId:              biz.tenantId,
        businessId:            biz.id,
        whatsappIntegrationId: null as string | null,
        phoneNumberId,
      };
    }

    this.logger.warn(`resolveTenant: no record found for phoneNumberId=${phoneNumberId} — not in WhatsAppIntegration or Business`);
    return null;
  }

  // ── Change value processing ───────────────────────────────────────────────

  async processChangeValue(value: WAChangeValue): Promise<void> {
    const phoneNumberId = value.metadata?.phone_number_id;
    if (!phoneNumberId) return;

    this.logger.log(
      `Webhook change: phoneNumberId=${phoneNumberId} msgs=${value.messages?.length ?? 0} statuses=${value.statuses?.length ?? 0}`,
    );

    const identity = await this.resolveTenant(phoneNumberId);
    if (!identity) {
      this.logger.warn(`No tenant for phone_number_id=${phoneNumberId}`);
      return;
    }

    const contacts = value.contacts ?? [];

    // Process messages — sequential to preserve order
    for (const message of value.messages ?? []) {
      await this.dispatchInboundMessage(identity, message, contacts).catch(err =>
        this.logger.error(`Failed to dispatch message ${message.id}`, err),
      );
    }

    // Buffer delivery statuses — flushed to DB in bulk every 5 s
    for (const status of value.statuses ?? []) {
      this.processStatus(identity.tenantId, status);
    }
  }

  // ── Queue dispatch ─────────────────────────────────────────────────────────

  private async dispatchInboundMessage(
    identity: { tenantId: string; businessId: string; phoneNumberId: string; whatsappIntegrationId: string | null },
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

    // Fire outbound webhook event — fire-and-forget
    this.webhooks.dispatchEvent(identity.tenantId, 'message.received', {
      waMessageId:  message.id,
      from:         message.from,
      contactName,
      type:         message.type,
      content:      this.extractContent(message),
      businessId:   identity.businessId,
      phoneNumberId: identity.phoneNumberId,
    });
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

  // ── Status processing — buffered, flushed in bulk every 5 s ─────────────

  private processStatus(tenantId: string, status: WAStatus): void {
    const extras = status.status === 'failed' && status.errors?.length
      ? { errorCode: status.errors[0].code, errorTitle: status.errors[0].title }
      : undefined;
    this.statusBuffer.buffer(tenantId, status.id, status.status, extras);
  }
}
