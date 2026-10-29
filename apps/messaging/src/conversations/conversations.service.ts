import {
  Injectable, NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope, decryptSecret } from '@lib/common';

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(private readonly prisma: PrismaService) {}

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
    labels?: string[];
  }) {
    await this.findOne(scope, id); // 404 guard
    return this.prisma.conversation.update({
      where: { id },
      data:  {
        status:       data.status as any,
        isAiActive:   data.isAiActive,
        assignedToId: data.assignedToId,
        labels:       data.labels,
      },
    });
  }

  // ── Send outbound message ──────────────────────────────────────────────────

  async sendMessage(scope: TenantScope, conversationId: string, payload: {
    text?: string; mediaUrl?: string; mediaId?: string; mediaType?: string;
    mediaMimeType?: string; mediaSize?: number; type?: string; isNote?: boolean;
    interactive?: Record<string, unknown>; replyToId?: string;
  }) {
    this.logger.log(`sendMessage start — conversationId=${conversationId} tenantId=${scope.tenantId} businessId=${scope.businessId} type=${payload.type ?? 'TEXT'} isNote=${payload.isNote}`);

    const { data: conv } = await this.findOne(scope, conversationId);
    this.logger.log(`sendMessage conv found — whatsappIntegrationId=${conv.whatsappIntegrationId ?? 'null'}`);

    const isInteractive = (payload.type ?? '').toUpperCase() === 'INTERACTIVE';
    if (!payload.text && !payload.mediaUrl && !isInteractive) {
      this.logger.warn('sendMessage — missing text/mediaUrl/interactive');
      throw new BadRequestException('Either text, mediaUrl, or interactive payload is required');
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

    const contact = conv.contact as any;
    const to: string = contact.phone ?? contact.waId;
    this.logger.log(`sendMessage contact — to=${to ? to.slice(0, 6) + '***' : 'MISSING'}`);
    if (!to) throw new BadRequestException('Contact has no phone number');

    if (!payload.isNote) {
      const accessToken = decryptSecret(integration.accessToken);
      if (!accessToken) throw new BadRequestException('WhatsApp integration access token could not be decrypted — check ENCRYPTION_KEY');
      this.logger.log(`sendMessage → calling Meta API via sendWhatsApp`);
      await this.sendWhatsApp(integration.phoneNumberId, accessToken, to, payload);
      this.logger.log(`sendMessage ← Meta API OK`);
    }

    const messageData: any = {
      tenantId:       scope.tenantId,
      businessId:     scope.businessId,
      conversationId,
      sentById:       scope.userId,
      direction:      'OUTBOUND',
      type:           (payload.type ?? 'TEXT') as any,
      content:        payload.text,
      mediaUrl:       payload.mediaUrl,
      mediaType:      payload.mediaType,
      mediaMimeType:  payload.mediaMimeType,
      status:         payload.isNote ? 'DELIVERED' : 'SENT',
      isNote:         payload.isNote ?? false,
      isAiGenerated:  false,
      replyToId:      payload.replyToId ?? null,
    };
    if (payload.interactive) {
      messageData.metadata = { interactive: payload.interactive };
    }
    if (payload.mediaId != null) {
      messageData.mediaId = payload.mediaId;
    }
    const message = await this.prisma.message.create({ data: messageData });
    this.logger.log(`sendMessage saved — messageId=${message.id}`);

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data:  {
        lastMessageAt:      new Date(),
        lastMessagePreview: payload.text?.slice(0, 100)
          ?? (payload.mediaType === 'image'    ? '📷 Photo'
            : payload.mediaType === 'video'    ? '🎥 Video'
            : payload.mediaType === 'audio'    ? '🎵 Voice message'
            : payload.mediaType === 'document' ? '📄 Document'
            :                                    '📎 Attachment'),
      },
    });

    this.logger.log(`sendMessage done — messageId=${message.id}`);
    return message;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private async sendWhatsApp(
    phoneNumberId: string,
    accessToken:   string,
    to:            string,
    payload:       {
      text?: string; mediaUrl?: string; mediaId?: string; type?: string;
      interactive?: Record<string, unknown>; replyToId?: string;
    },
  ) {
    const type = (payload.type ?? 'text').toLowerCase();
    let body: Record<string, unknown>;

    if (type === 'interactive' && payload.interactive) {
      body = { type: 'interactive', interactive: payload.interactive };
    } else if (type === 'text' || (!payload.mediaUrl && !payload.mediaId)) {
      body = { type: 'text', text: { body: payload.text, preview_url: false } };
    } else {
      const mediaPayload = payload.mediaId
        ? { id: payload.mediaId }
        : { link: payload.mediaUrl };
      body = { type, [type]: mediaPayload };
    }

    const apiBody: Record<string, unknown> = { messaging_product: 'whatsapp', to, ...body };
    if (payload.replyToId) {
      apiBody.context = { message_id: payload.replyToId };
    }

    const metaUrl = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
    this.logger.log(`sendWhatsApp → ${metaUrl} type=${type} tokenPrefix=${accessToken.slice(0, 6)}...`);

    const res = await fetch(
      metaUrl,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(apiBody),
      },
    );

    const responseText = await res.text();
    if (!res.ok) {
      this.logger.error(`sendWhatsApp ← Meta ${res.status} ${res.statusText}: ${responseText.slice(0, 600)}`);
      throw new BadRequestException(`WhatsApp API error: ${responseText}`);
    }
    this.logger.log(`sendWhatsApp ← Meta ${res.status} OK: ${responseText.slice(0, 200)}`);
  }
}
