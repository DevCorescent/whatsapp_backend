import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '@lib/prisma';
import { WebhookDispatchService, decryptSecret } from '@lib/common';
import { StatusBufferService } from './status-buffer.service';
import { InboundPipelineService } from './inbound-pipeline.service';
import type { WAChangeValue, WAMessage, WAStatus, WAContact } from './webhook.types';

interface IntegrationRow {
  id:       string;
  tenantId: string;
  businessId: string;
  appSecret:  string | null;
  business:   { whatsappAppSecret: string | null } | null;
}

const TYPE_MAP: Record<string, string> = {
  text: 'TEXT', image: 'IMAGE', audio: 'AUDIO', video: 'VIDEO',
  document: 'DOCUMENT', sticker: 'STICKER', location: 'LOCATION',
  interactive: 'INTERACTIVE', button: 'BUTTON', reaction: 'REACTION',
};

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  private readonly integrationCache = new Map<string, { data: IntegrationRow; expiresAt: number }>();
  private readonly INTEGRATION_TTL_MS = 5 * 60 * 1_000;

  constructor(
    private readonly prisma:       PrismaService,
    private readonly cfg:          ConfigService,
    private readonly webhooks:     WebhookDispatchService,
    private readonly statusBuffer: StatusBufferService,
    private readonly pipeline:     InboundPipelineService,
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

    this.logger.warn(`resolveTenant: no record for phoneNumberId=${phoneNumberId}`);
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

    for (const message of value.messages ?? []) {
      await this.saveInboundMessage(identity, message, contacts).catch(err =>
        this.logger.error(`Failed to save inbound message ${message.id}`, err),
      );
    }

    for (const status of value.statuses ?? []) {
      this.processStatus(identity.tenantId, status);
    }
  }

  // ── Inbound message — direct DB write, no queue ───────────────────────────

  private async saveInboundMessage(
    identity: { tenantId: string; businessId: string; phoneNumberId: string; whatsappIntegrationId: string | null },
    message: WAMessage,
    contacts: WAContact[],
  ): Promise<void> {
    const contact    = contacts.find(c => c.wa_id === message.from) ?? contacts[0];
    const contactName = contact?.profile?.name;
    const contactWaId = contact?.bsuid ?? contact?.username ?? contact?.wa_id ?? message.from;
    const phone       = message.from;
    const content     = this.extractContent(message);

    // 1. Upsert contact
    const contactRow = await this.prisma.contact.upsert({
      where:  { phone_businessId: { phone, businessId: identity.businessId } },
      create: {
        tenantId:   identity.tenantId,
        businessId: identity.businessId,
        phone,
        waId:       contactWaId ?? phone,
        name:       contactName ?? '',
      },
      update: {
        ...(contactName ? { name: contactName } : {}),
        ...(contactWaId ? { waId: contactWaId } : {}),
      },
    });

    // 2. Find or create conversation
    let conversation = await this.prisma.conversation.findFirst({
      where:   { tenantId: identity.tenantId, businessId: identity.businessId, contactId: contactRow.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: {
          tenantId:              identity.tenantId,
          businessId:            identity.businessId,
          contactId:             contactRow.id,
          whatsappIntegrationId: identity.whatsappIntegrationId,
          isAiActive:            false,
          status:                'OPEN',
        },
      });
    }

    // 3. Save message + update conversation (idempotent via waMessageId unique)
    try {
      await this.prisma.$transaction([
        this.prisma.message.create({
          data: {
            tenantId:       identity.tenantId,
            businessId:     identity.businessId,
            conversationId: conversation.id,
            waMessageId:    message.id,
            direction:      'INBOUND',
            status:         'DELIVERED',
            type:           (TYPE_MAP[message.type] ?? 'TEXT') as any,
            content,
            metadata:       message as any,
          },
        }),
        this.prisma.conversation.update({
          where: { id: conversation.id },
          data: {
            status:             'OPEN',
            lastMessageAt:      new Date(),
            lastMessagePreview: content.slice(0, 100),
            unreadCount:        { increment: 1 },
          },
        }),
      ]);
      this.logger.log(`Saved inbound ${message.id} → conversation ${conversation.id}`);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        this.logger.debug(`Duplicate inbound ${message.id}, skipping`);
        return;
      }
      throw err;
    }

    // 4. Fire outbound webhook event — fire-and-forget
    this.webhooks.dispatchEvent(identity.tenantId, 'message.received', {
      waMessageId:   message.id,
      from:          message.from,
      contactName,
      type:          message.type,
      content,
      businessId:    identity.businessId,
      phoneNumberId: identity.phoneNumberId,
    });

    // 5. Pusher real-time notification — fire-and-forget
    this.triggerPusher(identity.tenantId, { conversationId: conversation.id }).catch(() => {});

    // 6. Chatbot flow + AI auto-reply pipeline — fire-and-forget
    this.pipeline.process({
      tenantId:           identity.tenantId,
      businessId:         identity.businessId,
      conversationId:     conversation.id,
      contactId:          contactRow.id,
      content,
      interactiveReplyId: (message as any).interactive?.list_reply?.id
                       ?? (message as any).interactive?.button_reply?.id
                       ?? null,
    }).catch((err) => this.logger.error(`InboundPipeline failed conv=${conversation.id}`, err?.message ?? err));
  }

  private async triggerPusher(tenantId: string, data: Record<string, unknown>): Promise<void> {
    const appId   = this.cfg.get<string>('PUSHER_APP_ID', '');
    const key     = this.cfg.get<string>('PUSHER_KEY', '');
    const secret  = this.cfg.get<string>('PUSHER_SECRET', '');
    const cluster = this.cfg.get<string>('PUSHER_CLUSTER', 'mt1');
    if (!appId || !key || !secret) return;

    const body      = JSON.stringify({ channel: `tenant-${tenantId}`, name: 'new-message', data: JSON.stringify(data) });
    const bodyMd5   = crypto.createHash('md5').update(body).digest('hex');
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // Params must be sorted alphabetically for Pusher's HMAC signature
    const params = new URLSearchParams({ auth_key: key, auth_timestamp: timestamp, auth_version: '1.0', body_md5: bodyMd5 });
    params.sort();
    const signature = crypto.createHmac('sha256', secret).update(`POST\n/apps/${appId}/events\n${params.toString()}`).digest('hex');
    params.append('auth_signature', signature);

    await fetch(`https://api-${cluster}.pusher.com/apps/${appId}/events?${params.toString()}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
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
