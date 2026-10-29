import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { RealtimeService } from './realtime.service';
import { toRtConversation, toRtMessage, type RtConversationSummary } from './events';

/**
 * Loads the freshly written Message + its conversation summary and broadcasts
 * them to the business room. Every code path that persists a message calls this
 * after its own writes (and conversation preview update) are done.
 */
@Injectable()
export class MessageEventsService {
  private readonly logger = new Logger(MessageEventsService.name);

  constructor(
    private readonly prisma:   PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async messageNew(messageId: string): Promise<void> {
    try {
      const row = await this.prisma.message.findUnique({
        where:   { id: messageId },
        include: {
          sentBy:       { select: { id: true, name: true } },
          conversation: {
            include: { contact: { select: { id: true, name: true, phone: true, avatarUrl: true } } },
          },
        },
      });
      if (!row?.businessId) return;
      this.realtime.toBusiness(row.businessId, 'message:new', {
        message:      toRtMessage(row),
        conversation: toRtConversation(row.conversation),
      });
    } catch (err: any) {
      this.logger.warn(`message:new emit failed for ${messageId}: ${err?.message ?? err}`);
    }
  }

  async messageUpdated(messageId: string, patch: Record<string, unknown>): Promise<void> {
    try {
      const row = await this.prisma.message.findUnique({
        where:  { id: messageId },
        select: { businessId: true, conversationId: true },
      });
      if (!row?.businessId) return;
      this.realtime.toBusiness(row.businessId, 'message:updated', {
        messageId, conversationId: row.conversationId, patch,
      });
    } catch (err: any) {
      this.logger.warn(`message:updated emit failed for ${messageId}: ${err?.message ?? err}`);
    }
  }

  async conversationUpdated(conversationId: string, patch?: Partial<RtConversationSummary>): Promise<void> {
    try {
      const row = await this.prisma.conversation.findUnique({
        where:   { id: conversationId },
        include: { contact: { select: { id: true, name: true, phone: true, avatarUrl: true } } },
      });
      if (!row) return;
      this.realtime.toBusiness(row.businessId, 'conversation:updated', {
        id:    conversationId,
        patch: patch ?? toRtConversation(row),
      });
    } catch (err: any) {
      this.logger.warn(`conversation:updated emit failed for ${conversationId}: ${err?.message ?? err}`);
    }
  }
}
