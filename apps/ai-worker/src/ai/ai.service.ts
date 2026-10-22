import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly client: OpenAI;
  private readonly defaultModel: string;

  constructor(private readonly cfg: ConfigService) {
    const openrouterKey = cfg.get('OPENROUTER_API_KEY');
    const groqKey = cfg.get('GROQ_API_KEY');

    if (openrouterKey) {
      this.client = new OpenAI({
        apiKey: openrouterKey,
        baseURL: 'https://openrouter.ai/api/v1',
      });
      this.defaultModel = 'meta-llama/llama-3.3-70b-instruct';
    } else {
      this.client = new OpenAI({
        apiKey: groqKey ?? '',
        baseURL: 'https://api.groq.com/openai/v1',
      });
      this.defaultModel = cfg.get('GROQ_MODEL', 'llama-3.3-70b-versatile');
    }
  }

  async generateReply(
    history: ChatMessage[],
    systemPrompt: string,
    knowledgeContext: string | null,
    model?: string,
    opts?: { temperature?: number; maxTokens?: number },
  ): Promise<string> {
    const resolvedModel = this.resolveModel(model);
    const temperature = opts?.temperature ?? 0.7;
    const maxTokens   = opts?.maxTokens   ?? 500;

    const systemContent = knowledgeContext
      ? `${systemPrompt}\n\n---\nRelevant knowledge:\n${knowledgeContext}`
      : systemPrompt;

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemContent },
      ...history,
    ];

    const completion = await this.client.chat.completions.create({
      model: resolvedModel,
      messages,
      temperature,
      max_tokens: maxTokens,
    });

    return completion.choices[0]?.message?.content?.trim() ?? '';
  }

  private resolveModel(model?: string): string {
    // OpenRouter models contain '/', direct Groq models do not
    if (model && model.includes('/')) return model;
    return this.defaultModel;
  }
}
