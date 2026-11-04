import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { PrismaService } from '@lib/prisma';
import {
  RealtimeService, RedisService, MessageEventsService, NotificationsService, AGENT_ROLES,
} from '@lib/common';
import { QUEUE_CALLS } from '@lib/queue';
import { WebhookService } from '../webhook/webhook.service';
import { InboundPipelineService } from '../webhook/inbound-pipeline.service';
import type { WACall, WAChangeValue, WAContact } from '../webhook/webhook.types';
import { CallsService, OFFER_TTL_SEC, RING_TIMEOUT_MS } from './calls.service';

export interface CallTimeoutJob {
  callId: string;
}

/** Handles the `calls` webhook field: a ringing user-initiated call, and every hang-up. */
@Injectable()
export class CallsWebhookService {
  private readonly logger = new Logger(CallsWebhookService.name);

  constructor(
    private readonly prisma:        PrismaService,
    private readonly redis:         RedisService,
    private readonly realtime:      RealtimeService,
    private readonly events:        MessageEventsService,
    private readonly notifications: NotificationsService,
    private readonly webhook:       WebhookService,
    private readonly pipeline:      InboundPipelineService,
    private readonly calls:         CallsService,
    @InjectQueue(QUEUE_CALLS) private readonly queue: Queue<CallTimeoutJob>,
  ) {}

  async process(value: WAChangeValue): Promise<void> {
    const phoneNumberId = value.metadata?.phone_number_id;
    if (!phoneNumberId || !value.calls?.length) return;

    const identity = await this.webhook.resolveTenant(phoneNumberId);
    if (!identity?.whatsappIntegrationId) {
      this.logger.warn(`calls webhook for unknown/legacy phoneNumberId=${phoneNumberId}`);
      return;
    }

    for (const call of value.calls) {
      try {
        if (call.event === 'connect' && call.direction === 'USER_INITIATED') {
          await this.onIncoming({ ...identity, whatsappIntegrationId: identity.whatsappIntegrationId }, call, value.contacts ?? [], value.metadata.display_phone_number);
        } else if (call.event === 'terminate') {
          await this.onTerminate(call, value.errors);
        } else {
          this.logger.debug(`calls event ignored: ${call.event} ${call.direction}`);
        }
      } catch (err: any) {
        this.logger.error(`calls webhook ${call.event} ${call.id} failed: ${err?.message ?? err}`);
      }
    }
  }

  private async onIncoming(
    identity: { tenantId: string; businessId: string; whatsappIntegrationId: string; phoneNumberId: string },
    call: WACall,
    contacts: WAContact[],
    displayPhoneNumber: string,
  ) {
    const offerSdp = call.session?.sdp;
    if (!offerSdp) {
      this.logger.warn(`connect without SDP offer for ${call.id}`);
      return;
    }
    const waContact = contacts.find(c => c.wa_id === call.from) ?? contacts[0];
    const phone = call.from ?? waContact?.wa_id;
    if (!phone) return;

    const { contact, conversation, contactCreated } = await this.webhook.resolveContactAndConversation(
      identity, phone, { name: waContact?.profile?.name, waId: waContact?.bsuid ?? waContact?.username ?? waContact?.wa_id },
    );

    // Meta retries webhooks; the unique waCallId makes this idempotent.
    const existing = await this.prisma.call.findUnique({ where: { waCallId: call.id }, select: { id: true } });
    if (existing) {
      await this.redis.client.set(this.calls.offerKey(call.id), offerSdp, 'EX', OFFER_TTL_SEC);
      return;
    }

    const row = await this.prisma.call.create({
      data: {
        waCallId:              call.id,
        tenantId:              identity.tenantId,
        businessId:            identity.businessId,
        whatsappIntegrationId: identity.whatsappIntegrationId,
        contactId:             contact.id,
        conversationId:        conversation.id,
        direction:             'INBOUND',
        status:                'RINGING',
        fromPhone:             phone,
        toPhone:               call.to,
        ringingAt:             new Date(Number(call.timestamp) * 1000 || Date.now()),
        metadata:              { displayPhoneNumber } as any,
      },
    });
    await this.redis.client.set(this.calls.offerKey(call.id), offerSdp, 'EX', OFFER_TTL_SEC);

    const sys = await this.prisma.message.create({
      data: {
        tenantId:       identity.tenantId,
        businessId:     identity.businessId,
        conversationId: conversation.id,
        direction:      'INBOUND',
        status:         'DELIVERED',
        type:           'SYSTEM',
        content:        'Incoming call',
        metadata:       { call: { callId: row.id, status: 'RINGING', direction: 'INBOUND' } } as any,
      },
      select: { id: true },
    });
    await this.prisma.call.update({ where: { id: row.id }, data: { metadata: { displayPhoneNumber, systemMessageId: sys.id } as any } });
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data:  { lastMessageAt: new Date(), lastMessagePreview: '📞 Incoming call' },
    });

    const ringingSince = row.ringingAt.toISOString();
    this.realtime.toBusiness(identity.businessId, 'call:incoming', {
      id: row.id, waCallId: call.id,
      contact: { id: contact.id, name: contact.name || null, phone: contact.phone },
      conversationId: conversation.id, integrationId: identity.whatsappIntegrationId,
      displayPhoneNumber, ringingSince, expiresAt: new Date(row.ringingAt.getTime() + RING_TIMEOUT_MS).toISOString(),
    });
    void this.events.messageNew(sys.id);

    // Nobody has the app open → an OS notification is the only way to get someone to the phone.
    const online = await this.realtime.onlineUsersInBusiness(identity.businessId);
    if (online.size === 0) {
      void this.notifications.notify({
        tenantId: identity.tenantId, businessId: identity.businessId,
        recipients: conversation.assignedToId ? { userIds: [conversation.assignedToId] } : { roles: AGENT_ROLES },
        type: 'SYSTEM', title: `Incoming WhatsApp call from ${contact.name || contact.phone}`,
        body: 'Open the inbox to answer', href: `/inbox?c=${conversation.id}`,
        data: { callId: row.id, conversationId: conversation.id }, dedupeKey: `call:${row.id}`,
      });
    }

    await this.queue.add('timeout', { callId: row.id }, { delay: RING_TIMEOUT_MS + 15_000, removeOnComplete: true, removeOnFail: true })
      .catch(err => this.logger.warn(`call timeout enqueue failed: ${err?.message ?? err}`));

    if (contactCreated) {
      void this.pipeline.triggerFlowForEvent({
        tenantId: identity.tenantId,
        businessId: identity.businessId,
        contactId: contact.id,
        conversationId: conversation.id,
        trigger: 'CONTACT_CREATED',
        variables: { contactName: contact.name, contactPhone: contact.phone },
      }).catch((err) => this.logger.warn(`Could not trigger contact-created flow for ${contact.id}: ${(err as Error).message}`));
    }
  }

  private async onTerminate(call: WACall, errors?: WAChangeValue['errors']) {
    const row = await this.prisma.call.findUnique({ where: { waCallId: call.id } });
    if (!row) return;

    const endedAt = call.end_time ? new Date(Number(call.end_time) * 1000) : new Date();
    const failed  = (call.status ?? '').toUpperCase() === 'FAILED';
    const err     = errors?.[0];

    if (failed) {
      await this.calls.transition(row.id, ['RINGING', 'CONNECTING', 'IN_PROGRESS'], {
        status: 'FAILED', endedAt, errorCode: err?.code ?? null, errorTitle: err?.title ?? err?.message ?? 'Call failed',
      });
      return;
    }
    if (row.status === 'IN_PROGRESS' || row.status === 'CONNECTING') {
      const duration = typeof call.duration === 'number'
        ? call.duration
        : row.answeredAt ? Math.max(0, Math.round((endedAt.getTime() - row.answeredAt.getTime()) / 1000)) : 0;
      await this.calls.transition(row.id, ['CONNECTING', 'IN_PROGRESS'], { status: 'COMPLETED', endedAt, durationSec: duration });
      return;
    }
    if (row.status === 'RINGING') {
      await this.calls.markMissed(row.id, endedAt);
    }
    // REJECTED / already terminal: Meta's echo of our own terminate — nothing to do.
  }
}
