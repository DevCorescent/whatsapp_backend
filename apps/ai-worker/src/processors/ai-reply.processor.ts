import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { PrismaService } from '@lib/prisma';
import { QUEUE_AI_REPLY } from '@lib/queue';
import { WhatsAppApiService } from '../whatsapp/whatsapp-api.service';
import { AiService, ChatMessage } from '../ai/ai.service';
import type { AiReplyJob } from '@lib/queue';

@Processor(QUEUE_AI_REPLY)
export class AiReplyProcessor {
  private readonly logger = new Logger(AiReplyProcessor.name);

  constructor(
    private readonly prisma:   PrismaService,
    private readonly whatsapp: WhatsAppApiService,
    private readonly ai:       AiService,
  ) {}

  @Process({ concurrency: 3 })
  async handle(job: Job<AiReplyJob>): Promise<void> {
    const d = job.data;
    this.logger.debug(`AI reply for conversation ${d.conversationId}`);

    // ── Setup phase (retryable on failure) ───────────────────────────────────
    const conversation = await this.prisma.conversation.findUnique({
      where:   { id: d.conversationId },
      include: { contact: true },
    });
    if (!conversation) throw new Error(`Conversation ${d.conversationId} not found`);

    if (!conversation.isAiActive) {
      this.logger.debug(`AI inactive for ${d.conversationId}, skipping`);
      return;
    }

    // Idempotency: skip if already replied after the trigger message
    const triggerMsg = await this.prisma.message.findFirst({
      where:  { waMessageId: d.waMessageId, tenantId: d.tenantId },
      select: { createdAt: true },
    });
    if (triggerMsg) {
      const alreadyReplied = await this.prisma.message.findFirst({
        where: {
          conversationId: d.conversationId,
          direction:      'OUTBOUND',
          isAiGenerated:  true,
          createdAt:      { gte: triggerMsg.createdAt },
        },
      });
      if (alreadyReplied) {
        this.logger.debug(`Already replied for ${d.waMessageId}, skipping`);
        return;
      }
    }

    const business = await this.prisma.business.findUnique({
      where:  { id: d.businessId },
      select: {
        aiEnabled:     true,
        autoReply:     true,
        aiModel:       true,
        aiTemperature: true,
        aiMaxTokens:   true,
        aiSystemPrompt: true,
        aiInstructions: true,
        aiPersonality:  true,
        name:           true,
      },
    });
    if (!business?.aiEnabled || !business?.autoReply) return;

    const creds = await this.resolveConversationCreds(conversation);
    if (!creds) {
      this.logger.warn(`No WhatsApp creds for conversation ${d.conversationId}`);
      return;
    }

    const dbMessages = await this.prisma.message.findMany({
      where:   { conversationId: d.conversationId, content: { not: null } },
      orderBy: { createdAt: 'desc' },
      take:    10,
    });
    if (!dbMessages.length) return;

    const history: ChatMessage[] = dbMessages
      .reverse()
      .filter(m => m.content !== null)
      .map(m => ({
        role:    m.direction === 'INBOUND' ? 'user' : 'assistant',
        content: m.content as string,
      }));
    if (!history.length) return;

    // ── Send phase (NOT retryable — return normally even on error) ───────────
    const systemPrompt = this.buildSystemPrompt(business);
    let reply: string;
    try {
      reply = await this.ai.generateReply(
        history,
        systemPrompt,
        null,
        business.aiModel ?? undefined,
        { temperature: business.aiTemperature, maxTokens: business.aiMaxTokens },
      );
    } catch (err) {
      this.logger.error(`AI generation failed for ${d.conversationId}`, err);
      return; // don't retry send phase
    }
    if (!reply) return;

    const sent = await this.whatsapp.sendTextMessage(
      creds.phoneNumberId, creds.accessToken, conversation.contact.phone, reply,
    );
    if (!sent) return;

    await this.prisma.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          tenantId:       d.tenantId,
          conversationId: d.conversationId,
          businessId:     d.businessId,
          waMessageId:    sent.messageId,
          direction:      'OUTBOUND',
          status:         'PENDING',
          type:           'TEXT' as any,
          content:        reply,
          isAiGenerated:  true,
        },
      });
      await tx.conversation.update({
        where: { id: d.conversationId },
        data: {
          lastMessageAt:      new Date(),
          lastMessagePreview: reply.slice(0, 100),
        },
      });
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private buildSystemPrompt(business: {
    name: string;
    aiSystemPrompt: string | null;
    aiInstructions: unknown;
    aiPersonality: string | null;
  }): string {
    const parts: string[] = [];
    if (business.aiSystemPrompt) parts.push(business.aiSystemPrompt);
    if (business.aiPersonality)  parts.push(`Personality: ${business.aiPersonality}`);
    if (
      business.aiInstructions &&
      typeof business.aiInstructions === 'object' &&
      !Array.isArray(business.aiInstructions)
    ) {
      const instr = (business.aiInstructions as Record<string, unknown>).text;
      if (typeof instr === 'string') parts.push(instr);
    }
    if (!parts.length) {
      parts.push(`You are a helpful assistant for ${business.name}. Respond concisely.`);
    }
    return parts.join('\n\n');
  }

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
}
