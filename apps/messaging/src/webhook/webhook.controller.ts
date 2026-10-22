import {
  Controller, Get, Post, Query, Headers, Req,
  HttpCode, HttpStatus, ForbiddenException, Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { WebhookService } from './webhook.service';
import type { WAWebhookPayload } from './webhook.types';

@Controller('webhook/whatsapp')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly webhookService: WebhookService,
    private readonly cfg:            ConfigService,
  ) {}

  // ── GET: Meta webhook verification challenge ──────────────────────────────
  @Get()
  verify(
    @Query('hub.mode')         mode:      string,
    @Query('hub.verify_token') token:     string,
    @Query('hub.challenge')    challenge: string,
  ): string {
    const expected = this.cfg.get('WHATSAPP_VERIFY_TOKEN', '');
    if (mode === 'subscribe' && token === expected) {
      this.logger.log('Webhook verified');
      return challenge;
    }
    throw new ForbiddenException('Webhook verification failed');
  }

  // ── POST: Inbound messages & statuses ─────────────────────────────────────
  @Post()
  @HttpCode(HttpStatus.OK)
  async inbound(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature: string,
  ) {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    const rawText = rawBody.toString('utf8');

    const phoneNumberId = this.webhookService.extractPhoneNumberId(rawText);
    const appSecret     = await this.webhookService.resolveAppSecret(phoneNumberId);

    if (!this.webhookService.verifySignature(rawBody, signature, appSecret)) {
      this.logger.warn('Signature verification failed');
      throw new ForbiddenException('Invalid signature');
    }

    try {
      const payload = JSON.parse(rawText) as WAWebhookPayload;

      if (payload?.object !== 'whatsapp_business_account') {
        return { success: true };
      }

      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          if (change.field === 'messages') {
            await this.webhookService.processChangeValue(change.value).catch(err =>
              this.logger.error(`Entry ${entry.id} processing error`, err),
            );
          }
        }
      }
    } catch (err) {
      this.logger.error('Unrecoverable webhook error', err);
    }

    // Always return 200 — Meta will retry on anything else
    return { success: true };
  }
}
