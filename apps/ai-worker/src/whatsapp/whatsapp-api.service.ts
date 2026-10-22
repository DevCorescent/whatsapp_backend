import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const META_BASE = 'https://graph.facebook.com';

@Injectable()
export class WhatsAppApiService {
  private readonly logger = new Logger(WhatsAppApiService.name);
  private readonly apiVersion: string;

  constructor(private readonly cfg: ConfigService) {
    this.apiVersion = cfg.get('WHATSAPP_API_VERSION', 'v19.0');
  }

  async sendTextMessage(
    phoneNumberId: string,
    apiKey: string,
    to: string,
    text: string,
  ): Promise<{ messageId: string } | null> {
    const url = `${META_BASE}/${this.apiVersion}/${phoneNumberId}/messages`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { body: text, preview_url: false },
        }),
      });
      const data: any = await res.json();
      if (!res.ok) {
        this.logger.warn(`sendTextMessage failed: ${JSON.stringify(data)}`);
        return null;
      }
      return { messageId: data?.messages?.[0]?.id };
    } catch (err) {
      this.logger.error('sendTextMessage error', err);
      return null;
    }
  }

  async markMessageAsRead(
    phoneNumberId: string,
    apiKey: string,
    messageId: string,
  ): Promise<void> {
    const url = `${META_BASE}/${this.apiVersion}/${phoneNumberId}/messages`;
    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
        }),
      });
    } catch {
      // best-effort, don't throw
    }
  }
}
