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
    const lastFromCustomer = [...dbMessages].find(m => m.direction === 'INBOUND')?.content ?? '';
    const knowledge = await this.knowledgeFor(conversation.businessId, lastFromCustomer);
    let reply: string;
    try {
      reply = await this.ai.generateReply(
        history,
        systemPrompt,
        knowledge,
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

  /**
   * What the workspace has written down that bears on this question.
   *
   * `generateReply` has always taken a knowledge argument and this passed `null`, so the
   * auto-reply answered from the system prompt alone: it never saw a single uploaded
   * document, however many were indexed, and said the same general thing to every
   * question. The agent-facing "AI reply" button did consult the knowledge base, which
   * is why the two gave different answers to the same message.
   *
   * A short message has nothing to match on, so the top documents go in regardless —
   * they are the business context either way.
   */
  private async knowledgeFor(businessId: string, question: string): Promise<string | null> {
    const q = (question ?? '').trim();
    try {
      const long = q.split(/\s+/).length > 3;
      let docs = await this.prisma.knowledgeDoc.findMany({
        where: long
          ? { businessId, isIndexed: true, content: { contains: q.slice(0, 80), mode: 'insensitive' } }
          : { businessId, isIndexed: true },
        take: 3,
        select: { name: true, content: true },
      });
      if (!docs.length && long) {
        docs = await this.prisma.knowledgeDoc.findMany({
          where: { businessId, isIndexed: true },
          take: 3,
          select: { name: true, content: true },
        });
      }

      // A document with no text is no use, and several carry none: the text has to be
      // extracted when it is uploaded, and for some file types it never was.
      const usable = docs.filter(d => (d.content ?? '').trim().length > 0);
      this.logger.log(
        `KB for business=${businessId} q="${q.slice(0, 40)}" docs=${docs.length} withText=${usable.length}`,
      );
      if (!usable.length) return null;

      return usable
        .map(d => [`## ${d.name}`, (d.content ?? '').slice(0, 4000)].join('\n'))
        .join('\n\n');
    } catch (err) {
      this.logger.warn(`knowledge lookup failed for ${businessId}: ${String(err).slice(0, 120)}`);
      return null;
    }
  }

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
