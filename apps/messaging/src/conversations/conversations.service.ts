import {
  Injectable, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

@Injectable()
export class ConversationsService {
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
          messages:   { orderBy: { createdAt: 'desc' }, take: 1 },
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

    const page = Math.max(1, query.page ?? 1);
    const pageSize = 50;
    const skip = (page - 1) * pageSize;
    const [messages, msgTotal] = await Promise.all([
      this.prisma.message.findMany({
        where: { conversationId: id, tenantId: scope.tenantId },
        skip, take: pageSize,
        orderBy: { createdAt: 'asc' },
        include: { sentBy: { select: { id: true, name: true } } },
      }),
      this.prisma.message.count({ where: { conversationId: id, tenantId: scope.tenantId } }),
    ]);
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
    const skip  = (page - 1) * limit;

    const [messages, total] = await Promise.all([
      this.prisma.message.findMany({
        where:   { conversationId, tenantId: scope.tenantId },
        skip, take: limit,
        orderBy: { createdAt: 'asc' },
        include: { sentBy: { select: { id: true, name: true } } },
      }),
      this.prisma.message.count({ where: { conversationId, tenantId: scope.tenantId } }),
    ]);

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
    const { data: conv } = await this.findOne(scope, conversationId);
    const isInteractive = (payload.type ?? '').toUpperCase() === 'INTERACTIVE';
    if (!payload.text && !payload.mediaUrl && !isInteractive) {
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

    if (!integration) throw new BadRequestException('No active WhatsApp integration found');
    if (!integration.accessToken) throw new BadRequestException('WhatsApp integration has no access token');

    const contact = conv.contact as any;
    const to: string = contact.phone ?? contact.waId;
    if (!to) throw new BadRequestException('Contact has no phone number');

    if (!payload.isNote) {
      await this.sendWhatsApp(integration.phoneNumberId, integration.accessToken, to, payload);
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

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data:  {
        lastMessageAt:      new Date(),
        lastMessagePreview: payload.text?.slice(0, 100) ?? '(media)',
      },
    });

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

    const res = await fetch(
      `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(apiBody),
      },
    );

    if (!res.ok) {
      const err = await res.text();
      throw new BadRequestException(`WhatsApp API error: ${err}`);
    }
  }
}
