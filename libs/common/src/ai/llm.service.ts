import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmOptions {
  model?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
}

/**
 * One place that talks to the language model.
 *
 * Auto-replies, lead qualification and handover decisions all need the same call with the
 * same provider rules, and the provider choice is a deployment detail: an OpenRouter key
 * takes precedence, otherwise Groq. A model id is only honoured on OpenRouter, where ids
 * contain a slash; sending a bare Groq name to OpenRouter is rejected, which is the kind
 * of thing worth getting wrong once rather than three times.
 *
 * Nothing here throws. A model that is unreachable returns null, and every caller treats
 * that as "no answer this time" rather than failing the message it was handling.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(private readonly cfg: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.get<string>('OPENROUTER_API_KEY') || this.cfg.get<string>('GROQ_API_KEY'));
  }

  /** The provider in use, for showing in settings. */
  provider(): 'openrouter' | 'groq' | null {
    if (this.cfg.get<string>('OPENROUTER_API_KEY')) return 'openrouter';
    if (this.cfg.get<string>('GROQ_API_KEY')) return 'groq';
    return null;
  }

  defaultModel(): string {
    return this.cfg.get<string>('OPENROUTER_API_KEY')
      ? (this.cfg.get<string>('OPENROUTER_MODEL') ?? 'meta-llama/llama-3.3-70b-instruct')
      : (this.cfg.get<string>('GROQ_MODEL') ?? 'llama-3.3-70b-versatile');
  }

  async complete(messages: LlmMessage[], opts: LlmOptions = {}): Promise<string | null> {
    const openRouterKey = this.cfg.get<string>('OPENROUTER_API_KEY', '');
    const groqKey = this.cfg.get<string>('GROQ_API_KEY', '');
    const apiKey = openRouterKey || groqKey;
    if (!apiKey) return null;

    const endpoint = openRouterKey
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : 'https://api.groq.com/openai/v1/chat/completions';

    // Only OpenRouter accepts a caller-chosen model, and only a namespaced one.
    const model = openRouterKey && opts.model?.includes('/') ? opts.model : this.defaultModel();

    try {
      const res = await fetch(endpoint, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Bearer ${apiKey}`,
          ...(openRouterKey ? { 'HTTP-Referer': 'https://whatscrm.app', 'X-Title': 'WhatsCRM' } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens:  opts.maxTokens ?? 500,
          temperature: opts.temperature ?? 0.7,
        }),
      });
      if (!res.ok) {
        this.logger.error(`Model ${model} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
        return null;
      }
      const json: any = await res.json();
      return json?.choices?.[0]?.message?.content ?? null;
    } catch (err) {
      this.logger.error(`Could not reach the model: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * A completion parsed as JSON.
   *
   * Models wrap JSON in prose and fenced code blocks however much you ask them not to, so
   * the first balanced object in the reply is what gets parsed rather than the whole
   * string. Returns null when there is nothing parseable, which the caller treats as
   * "could not qualify" instead of guessing.
   */
  async completeJson<T>(messages: LlmMessage[], opts: LlmOptions = {}): Promise<T | null> {
    const raw = await this.complete(messages, { ...opts, temperature: opts.temperature ?? 0.2 });
    if (!raw) return null;

    const json = extractJsonObject(raw);
    if (!json) {
      this.logger.warn(`Model reply held no JSON object: ${raw.slice(0, 200)}`);
      return null;
    }
    try {
      return JSON.parse(json) as T;
    } catch {
      this.logger.warn(`Model reply was not valid JSON: ${json.slice(0, 200)}`);
      return null;
    }
  }
}

/** The first balanced `{…}` in the text, ignoring braces inside strings. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
