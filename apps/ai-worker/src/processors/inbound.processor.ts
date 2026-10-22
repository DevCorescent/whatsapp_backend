import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Job, Queue } from 'bull';
import { PrismaService } from '@lib/prisma';
import { QUEUE_INBOUND_MESSAGE, QUEUE_AI_REPLY } from '@lib/queue';
import { WhatsAppApiService } from '../whatsapp/whatsapp-api.service';
import type { InboundMessageJob, AiReplyJob } from '@lib/queue';

const OPT_OUT = new Set(['STOP','UNSUBSCRIBE','CANCEL','END','QUIT','OPTOUT']);
const OPT_IN  = new Set(['START','SUBSCRIBE','YES','HELLO','HELP']);

@Processor(QUEUE_INBOUND_MESSAGE)
export class InboundProcessor {
  private readonly logger = new Logger(InboundProcessor.name);

  constructor(
    private readonly prisma:   PrismaService,
    private readonly whatsapp: WhatsAppApiService,
    @InjectQueue(QUEUE_AI_REPLY) private readonly aiQueue: Queue,
  ) {}

  @Process({ concurrency: 5 })
  async handle(job: Job<InboundMessageJob>): Promise<void> {
    const d = job.data;
    this.logger.debug(`Processing inbound ${d.waMessageId}`);
    try {
      await this.processIncoming(d);
    } catch (err) {
      this.logger.error(`Failed to process inbound ${d.waMessageId}`, err);
      throw err; // Bull retry
    }
  }

  // ── Core pipeline ─────────────────────────────────────────────────────────

  private async processIncoming(d: InboundMessageJob): Promise<void> {
    const contact = await this.upsertContact(
      d.tenantId, d.businessId, d.from, d.contactName, d.contactWaId,
    );

    const conversation = await this.findOrCreateConversation(
      d.tenantId, d.businessId, contact.id, d.whatsappIntegrationId,
    );

    const { isNew } = await this.saveInboundMessage(d.tenantId, conversation.id, d);
    if (!isNew) {
      this.logger.debug(`Duplicate message ${d.waMessageId}, skipping`);
      return;
    }

    const creds = await this.resolveConversationCreds(conversation);

    // Mark as read (best-effort)
    if (creds) {
      await this.whatsapp.markMessageAsRead(creds.phoneNumberId, creds.accessToken, d.waMessageId);
    }

    // Opt-out / opt-in
    const text = (d.content ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (OPT_OUT.has(text)) {
      await this.handleOptOut(contact.id, contact.phone, creds);
      return;
    }
    if (contact.optedOut) {
      if (OPT_IN.has(text)) await this.handleOptIn(contact.id, contact.phone, creds);
      return;
    }

    // Campaign reply credit
    await this.creditCampaignReply(d.tenantId, contact.phone).catch(() => {});

    // Chatbot flow execution (TODO: implement full flow engine)
    const flowHandled = false;

    if (!flowHandled) {
      await this.dispatchAiReply(d.tenantId, d.businessId, conversation, d.waMessageId);
    }
  }

  // ── Contact upsert ────────────────────────────────────────────────────────

  private async upsertContact(
    tenantId: string, businessId: string,
    phone: string, name?: string, waId?: string,
  ) {
    if (waId && waId !== phone) {
      const existing = await this.prisma.contact.findFirst({
        where: { tenantId, businessId, waId },
      });
      if (existing) {
        if (name && !existing.name) {
          return this.prisma.contact.update({ where: { id: existing.id }, data: { name } });
        }
        return existing;
      }
    }

    const effectivePhone = phone || waId || '';
    return this.prisma.contact.upsert({
      where:  { phone_businessId: { phone: effectivePhone, businessId } },
      create: { tenantId, businessId, phone: effectivePhone, waId: waId ?? effectivePhone, name: name ?? '' },
      update: { ...(name ? { name } : {}), ...(waId ? { waId } : {}) },
    });
  }

  // ── Conversation ──────────────────────────────────────────────────────────

  private async findOrCreateConversation(
    tenantId: string, businessId: string, contactId: string,
    whatsappIntegrationId: string | null,
  ) {
    const existing = await this.prisma.conversation.findFirst({
      where:   { tenantId, businessId, contactId },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return existing;

    const aiCfg = await this.resolveAiConfig(businessId);
    return this.prisma.conversation.create({
      data: {
        tenantId, businessId, contactId,
        whatsappIntegrationId,
        isAiActive: aiCfg.aiEnabled && aiCfg.autoReply,
        status: 'OPEN',
      },
    });
  }

  // ── Save inbound message ──────────────────────────────────────────────────

  private async saveInboundMessage(
    tenantId: string, conversationId: string, d: InboundMessageJob,
  ): Promise<{ isNew: boolean }> {
    const typeMap: Record<string, string> = {
      text: 'TEXT', image: 'IMAGE', audio: 'AUDIO', video: 'VIDEO',
      document: 'DOCUMENT', sticker: 'STICKER', location: 'LOCATION',
      interactive: 'INTERACTIVE', button: 'BUTTON', reaction: 'REACTION',
    };
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.message.create({
          data: {
            tenantId,
            conversationId,
            waMessageId: d.waMessageId,
            direction:   'INBOUND',
            status:      'DELIVERED',
            type:        (typeMap[d.type] ?? 'TEXT') as any,
            content:     d.content ?? '',
            metadata:    d.rawMessage as any,
            businessId:  (await tx.conversation.findUnique({ where: { id: conversationId }, select: { businessId: true } }))?.businessId,
          },
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: {
            status:             'OPEN',
            lastMessageAt:      new Date(),
            lastMessagePreview: (d.content ?? '').slice(0, 100),
            unreadCount:        { increment: 1 },
          },
        });
      });
      return { isNew: true };
    } catch (err: any) {
      if (err?.code === 'P2002') return { isNew: false }; // duplicate waMessageId
      throw err;
    }
  }

  // ── WhatsApp creds ────────────────────────────────────────────────────────

  private async resolveConversationCreds(conversation: {
    whatsappIntegrationId: string | null;
    businessId: string;
  }): Promise<{ phoneNumberId: string; accessToken: string } | null> {
    if (conversation.whatsappIntegrationId) {
      const row = await this.prisma.whatsAppIntegration.findUnique({
        where:  { id: conversation.whatsappIntegrationId },
        select: { phoneNumberId: true, accessToken: true },
      });
      if (row?.phoneNumberId && row?.accessToken) {
        return { phoneNumberId: row.phoneNumberId, accessToken: row.accessToken };
      }
    }
    const biz = await this.prisma.business.findUnique({
      where:  { id: conversation.businessId },
      select: { whatsappPhoneNumberId: true, whatsappAccessToken: true },
    });
    if (biz?.whatsappPhoneNumberId && biz?.whatsappAccessToken) {
      return { phoneNumberId: biz.whatsappPhoneNumberId, accessToken: biz.whatsappAccessToken };
    }
    return null;
  }

  // ── Opt-out / opt-in ─────────────────────────────────────────────────────

  private async handleOptOut(
    contactId: string, phone: string,
    creds: { phoneNumberId: string; accessToken: string } | null,
  ) {
    await this.prisma.contact.update({ where: { id: contactId }, data: { optedOut: true } });
    if (creds) {
      await this.whatsapp.sendTextMessage(
        creds.phoneNumberId, creds.accessToken, phone,
        'You have been unsubscribed. Reply START to re-subscribe.',
      );
    }
  }

  private async handleOptIn(
    contactId: string, phone: string,
    creds: { phoneNumberId: string; accessToken: string } | null,
  ) {
    await this.prisma.contact.update({ where: { id: contactId }, data: { optedOut: false } });
    if (creds) {
      await this.whatsapp.sendTextMessage(
        creds.phoneNumberId, creds.accessToken, phone,
        'You have been re-subscribed. Reply STOP at any time to opt out.',
      );
    }
  }

  // ── Campaign reply credit ─────────────────────────────────────────────────

  private async creditCampaignReply(tenantId: string, phone: string) {
    const cc = await this.prisma.campaignContact.findFirst({
      where: { tenantId, contact: { phone }, sentAt: { not: null }, repliedAt: null },
      orderBy: { sentAt: 'desc' },
    });
    if (!cc) return;
    await this.prisma.$transaction([
      this.prisma.campaignContact.update({ where: { id: cc.id }, data: { repliedAt: new Date() } }),
      this.prisma.campaign.update({ where: { id: cc.campaignId }, data: { repliedCount: { increment: 1 } } }),
    ]);
  }

  // ── AI dispatch ───────────────────────────────────────────────────────────

  private async resolveAiConfig(businessId: string) {
    const biz = await this.prisma.business.findUnique({
      where:  { id: businessId },
      select: { aiEnabled: true, autoReply: true, autoReplyDelay: true },
    }).catch(() => null);
    return {
      aiEnabled:      biz?.aiEnabled      ?? false,
      autoReply:      biz?.autoReply      ?? false,
      autoReplyDelay: biz?.autoReplyDelay ?? 0,
    };
  }

  private async dispatchAiReply(
    tenantId: string, businessId: string,
    conversation: { id: string; isAiActive: boolean },
    waMessageId: string,
  ) {
    if (!conversation.isAiActive) return;
    const aiCfg = await this.resolveAiConfig(businessId);
    if (!aiCfg.aiEnabled || !aiCfg.autoReply) return;

    const job: AiReplyJob = { tenantId, businessId, conversationId: conversation.id, waMessageId };
    await this.aiQueue.add(job, {
      delay:    (aiCfg.autoReplyDelay ?? 0) * 1000,
      attempts: 2,
      backoff:  { type: 'fixed', delay: 3000 },
      removeOnComplete: true,
    });
  }
}
