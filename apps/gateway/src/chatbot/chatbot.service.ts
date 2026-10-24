import { Injectable } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';
import { AiService } from '../ai/ai.service';

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful WhatsApp chatbot assistant. Answer concisely and helpfully.';

@Injectable()
export class ChatbotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai:     AiService,
  ) {}

  async respondChatbot(
    scope: TenantScope,
    body: { conversationId: string; message: string },
  ) {
    await this.ai.checkAiAccess(scope);

    // 1. Load conversation (scoped to business)
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: body.conversationId, tenantId: scope.tenantId, businessId: scope.businessId },
    });

    // 2. Get business AI settings
    const business = await this.prisma.business.findFirst({
      where:  { id: scope.businessId, tenantId: scope.tenantId },
      select: { aiSystemPrompt: true, aiPersonality: true, aiResponseTone: true, aiModel: true },
    });

    // 3. Find active chatbot flow matching the message
    const flows = await this.prisma.chatbotFlow.findMany({
      where: { businessId: scope.businessId, tenantId: scope.tenantId, isActive: true },
    });
    const lowerMsg = body.message.toLowerCase();
    const matchingFlow = flows.find(f => {
      if (f.trigger === 'KEYWORD' && Array.isArray(f.keywords)) {
        return f.keywords.some((k: string) => lowerMsg.includes(k.toLowerCase()));
      }
      return false;
    }) ?? flows[0] ?? null;

    // 4. Extract instruction from flow's first node
    const flowNodes = Array.isArray(matchingFlow?.nodes) ? matchingFlow.nodes as any[] : [];
    const flowInstruction = flowNodes[0]?.data?.message ?? flowNodes[0]?.data?.text ?? '';

    // 5. Load last 10 messages for conversation context
    const messages = await this.prisma.message.findMany({
      where:   { conversationId: body.conversationId, tenantId: scope.tenantId, isNote: false },
      orderBy: { createdAt: 'desc' },
      take:    10,
    });
    const history = messages
      .reverse()
      .map(m => `${m.direction === 'INBOUND' ? 'Customer' : 'Agent'}: ${m.content ?? ''}`)
      .join('\n');

    // 6. Build system prompt
    const basePrompt   = business?.aiSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const systemPrompt = flowInstruction
      ? `${basePrompt}\n\n${flowInstruction}`
      : basePrompt;

    // 7. Call AI
    const userPrompt  = history ? `${history}\nCustomer: ${body.message}` : `Customer: ${body.message}`;
    const aiResponse  = await this.ai.callAi(systemPrompt, userPrompt);

    return { success: true, data: { reply: aiResponse ?? '', sources: [] } };
  }
}
