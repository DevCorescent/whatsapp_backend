import {
  Injectable, NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope, decryptSecret, MessageEventsService } from '@lib/common';

const WA_API_VERSION = process.env.WHATSAPP_API_VERSION ?? 'v20.0';

const MEDIA_PREVIEW: Record<string, string> = {
  image: '📷 Photo', video: '🎥 Video', audio: '🎵 Voice message', document: '📄 Document', sticker: '😊 Sticker',
};

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: MessageEventsService,
  ) {}

  // ── List ───────────────────────────────────────────────────────────────────

  async findAll(scope: TenantScope, query: {
    page?: number; limit?: number; status?: string; search?: string;
    assignedToId?: string; isAiActive?: boolean;
  }) {
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 30);
    const skip  = (page - 1) * limit;

    const where: any = { tenantId: scope.tenantId, businessId: scope.businessId };
    if (query.status)        where.status      = query.status;
    if (query.assignedToId)  where.assignedToId = query.assignedToId;
    if (query.isAiActive != null) where.isAiActive = query.isAiActive;
    if (query.search) {
      where.contact = { OR: [
        { name:  { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search } },
      ]};
    }

    const [conversations, total] = await Promise.all([
      this.prisma.conversation.findMany({
        where, skip, take: limit,
        orderBy: { lastMessageAt: 'desc' },
        include: {
          contact:    { select: { id: true, name: true, phone: true, avatarUrl: true } },
          assignedTo: { select: { id: true, name: true, email: true } },
        },
      }),
      this.prisma.conversation.count({ where }),
    ]);

    return { success: true, data: conversations, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }, businessId: scope.businessId };
  }

  // ── Get one ────────────────────────────────────────────────────────────────

  async findOne(scope: TenantScope, id: string, query: { page?: number } = {}) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id, tenantId: scope.tenantId, businessId: scope.businessId },
      include: {
        contact:    true,
        assignedTo: { select: { id: true, name: true, email: true } },
      },
    });
    if (!conv) throw new NotFoundException('Conversation not found');

    const pageSize = 50;
    // page 1 = most recent 50; page 2 = the 50 before that; etc.
    const page = Math.max(1, query.page ?? 1);
    const msgTotal = await this.prisma.message.count({ where: { conversationId: id, tenantId: scope.tenantId } });
    // skip from the end so page 1 is always the newest messages
    const skipFromEnd = (page - 1) * pageSize;
    const messages = await this.prisma.message.findMany({
      where:   { conversationId: id, tenantId: scope.tenantId },
      orderBy: { createdAt: 'desc' },
      skip:    skipFromEnd,
      take:    pageSize,
      include: { sentBy: { select: { id: true, name: true } } },
    });
    messages.reverse(); // display oldest → newest in the chat window
    // Reset unread count
    await this.prisma.conversation.update({ where: { id }, data: { unreadCount: 0 } });

    return { success: true, data: { ...conv, messages, pagination: { page, pageSize, total: msgTotal, totalPages: Math.ceil(msgTotal / pageSize) } } };
  }

  // ── Messages in a conversation ─────────────────────────────────────────────

  async getMessages(scope: TenantScope, conversationId: string, query: {
    page?: number; limit?: number;
  }) {
    await this.findOne(scope, conversationId); // 404 guard

    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 50);

    const total = await this.prisma.message.count({ where: { conversationId, tenantId: scope.tenantId } });
    const skipFromEnd = (page - 1) * limit;
    const messages = await this.prisma.message.findMany({
      where:   { conversationId, tenantId: scope.tenantId },
      orderBy: { createdAt: 'desc' },
      skip:    skipFromEnd,
      take:    limit,
      include: { sentBy: { select: { id: true, name: true } } },
    });
    messages.reverse();

    // Mark conversation as read
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data:  { unreadCount: 0 },
    });

    return { messages, total, page, limit };
  }

  // ── Update conversation ────────────────────────────────────────────────────

  async update(scope: TenantScope, id: string, data: {
    status?: string; isAiActive?: boolean; assignedToId?: string | null;
    labels?: string[]; unreadCount?: number;
  }) {
    const exists = await this.prisma.conversation.findFirst({
      where: { id, tenantId: scope.tenantId, businessId: scope.businessId }, select: { id: true },
    });
    if (!exists) throw new NotFoundException('Conversation not found');

    const updated = await this.prisma.conversation.update({
      where: { id },
      data:  {
        status:       data.status as any,
        isAiActive:   data.isAiActive,
        assignedToId: data.assignedToId,
        labels:       data.labels,
        ...(data.unreadCount === 0 ? { unreadCount: 0 } : {}),
      },
    });
    void this.events.conversationUpdated(id);
    return updated;
  }

  // ── Send outbound message ──────────────────────────────────────────────────

  async sendMessage(scope: TenantScope, conversationId: string, payload: {
    text?: string; mediaUrl?: string; mediaId?: string; mediaType?: string;
    mediaMimeType?: string; mediaSize?: number; fileName?: string; type?: string; isNote?: boolean;
    interactive?: Record<string, unknown>; replyToId?: string; clientId?: string;
  }) {
    this.logger.log(`sendMessage start — conversationId=${conversationId} tenantId=${scope.tenantId} businessId=${scope.businessId} type=${payload.type ?? 'TEXT'} isNote=${payload.isNote}`);

    const conv = await this.prisma.conversation.findFirst({
      where:   { id: conversationId, tenantId: scope.tenantId, businessId: scope.businessId },
      include: { contact: { select: { phone: true, waId: true } } },
    });
    if (!conv) throw new NotFoundException('Conversation not found');

    const isInteractive = (payload.type ?? '').toUpperCase() === 'INTERACTIVE';
    const hasMedia = Boolean(payload.mediaUrl || payload.mediaId);
    if (!payload.text && !hasMedia && !isInteractive) {
      this.logger.warn('sendMessage — missing text/media/interactive');
      throw new BadRequestException('Either text, media, or interactive payload is required');
    }

    // Load WhatsApp integration for this conversation
    const integration = conv.whatsappIntegrationId
      ? await this.prisma.whatsAppIntegration.findUnique({
          where: { id: conv.whatsappIntegrationId },
        })
      : await this.prisma.whatsAppIntegration.findFirst({
          where: { businessId: scope.businessId, isActive: true },
        });

    this.logger.log(`sendMessage integration — found=${!!integration} phoneNumberId=${integration?.phoneNumberId ?? 'null'} hasToken=${!!(integration?.accessToken)}`);

    if (!integration) throw new BadRequestException('No active WhatsApp integration found');
    if (!integration.accessToken) throw new BadRequestException('WhatsApp integration has no access token');

    const to = conv.contact.phone ?? conv.contact.waId ?? '';
    this.logger.log(`sendMessage contact — to=${to ? to.slice(0, 6) + '***' : 'MISSING'}`);
    if (!to) throw new BadRequestException('Contact has no phone number');

    let waMessageId: string | null = null;
    if (!payload.isNote) {
      const accessToken = decryptSecret(integration.accessToken);
      if (!accessToken) throw new BadRequestException('WhatsApp integration access token could not be decrypted — check ENCRYPTION_KEY');
      waMessageId = await this.sendWhatsApp(integration.phoneNumberId, accessToken, to, payload);
      this.logger.log(`sendMessage ← Meta API OK waMessageId=${waMessageId ?? 'none'}`);
    }

    const mediaKind = (payload.mediaType ?? (hasMedia ? (payload.type ?? '').toLowerCase() : '')).toLowerCase();
    const metadata: Record<string, unknown> = {};
    if (payload.interactive) metadata.interactive = payload.interactive;
    if (payload.mediaId)     metadata.mediaId = payload.mediaId;
    if (payload.fileName)    metadata.filename = payload.fileName;
    if (payload.clientId)    metadata.clientId = payload.clientId;

    const message = await this.prisma.message.create({
      data: {
        tenantId:       scope.tenantId,
        businessId:     scope.businessId,
        conversationId,
        sentById:       scope.userId,
        waMessageId,
        direction:      'OUTBOUND',
        type:           (payload.type ?? 'TEXT') as any,
        content:        payload.text ?? null,
        mediaUrl:       payload.mediaUrl ?? null,
        mediaType:      payload.mediaType ?? null,
        mediaMimeType:  payload.mediaMimeType ?? null,
        mediaSize:      payload.mediaSize ?? null,
        metadata:       Object.keys(metadata).length ? (metadata as any) : undefined,
        status:         payload.isNote ? 'DELIVERED' : 'SENT',
        isNote:         payload.isNote ?? false,
        isAiGenerated:  false,
        replyToId:      payload.replyToId ?? null,
      },
      include: { sentBy: { select: { id: true, name: true } } },
    });
    this.logger.log(`sendMessage saved — messageId=${message.id}`);

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data:  {
        lastMessageAt:      message.createdAt,
        lastMessagePreview: payload.text?.slice(0, 100)
          ?? (hasMedia ? (MEDIA_PREVIEW[mediaKind] ?? '📎 Attachment') : (isInteractive ? '💬 Interactive' : '')),
      },
    });

    void this.events.messageNew(message.id);
    this.logger.log(`sendMessage done — messageId=${message.id}`);
    return message;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  /** Sends via Meta Graph and returns the WhatsApp message id (`wamid.…`) for status tracking. */
  private async sendWhatsApp(
    phoneNumberId: string,
    accessToken:   string,
    to:            string,
    payload:       {
      text?: string; mediaUrl?: string; mediaId?: string; type?: string; fileName?: string;
      interactive?: Record<string, unknown>; replyToId?: string;
    },
  ): Promise<string | null> {
    const type = (payload.type ?? 'text').toLowerCase();
    let body: Record<string, unknown>;

    if (type === 'interactive' && payload.interactive) {
      body = { type: 'interactive', interactive: payload.interactive };
    } else if (type === 'text' || (!payload.mediaUrl && !payload.mediaId)) {
      body = { type: 'text', text: { body: payload.text, preview_url: false } };
    } else {
      const media: Record<string, unknown> = payload.mediaId ? { id: payload.mediaId } : { link: payload.mediaUrl };
      if (payload.text && type !== 'audio' && type !== 'sticker') media.caption = payload.text;
      if (type === 'document' && payload.fileName) media.filename = payload.fileName;
      body = { type, [type]: media };
    }

    const apiBody: Record<string, unknown> = { messaging_product: 'whatsapp', to, ...body };
    if (payload.replyToId) {
      // Meta wants the WhatsApp id of the quoted message, not our row id.
      const quoted = await this.prisma.message.findUnique({ where: { id: payload.replyToId }, select: { waMessageId: true } });
      if (quoted?.waMessageId) apiBody.context = { message_id: quoted.waMessageId };
    }

    const metaUrl = `https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/messages`;
    this.logger.log(`sendWhatsApp → ${metaUrl} type=${type}`);

    const res = await fetch(metaUrl, {
      method:  'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(apiBody),
    });

    const responseText = await res.text();
    if (!res.ok) {
      this.logger.error(`sendWhatsApp ← Meta ${res.status} ${res.statusText}: ${responseText.slice(0, 600)}`);
      let reason = responseText;
      try { reason = JSON.parse(responseText)?.error?.message ?? responseText; } catch { /* raw */ }
      throw new BadRequestException(`WhatsApp API error: ${reason}`);
    }
    try {
      return (JSON.parse(responseText)?.messages?.[0]?.id as string | undefined) ?? null;
    } catch {
      return null;
    }
  }
}
