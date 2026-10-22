import {
  Controller, Get, Post, Query, Headers, Req,
  HttpCode, HttpStatus, ForbiddenException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { WebhookService } from '../../../../apps/messaging/src/webhook/webhook.service';
import { BillingService } from '../../../../apps/billing/src/billing.service';
import type { WAWebhookPayload } from '../../../../apps/messaging/src/webhook/webhook.types';

@ApiTags('webhook')
@Controller('webhook')
export class GatewayWebhookController {
  private readonly logger = new Logger(GatewayWebhookController.name);

  constructor(
    private readonly webhook: WebhookService,
    private readonly billing: BillingService,
    private readonly cfg:     ConfigService,
  ) {}

  // ── GET: Meta webhook verification challenge ──────────────────────────────
  @Get('whatsapp')
  @ApiOperation({ summary: 'Meta webhook verification challenge' })
  verifyWhatsApp(
    @Query('hub.mode')         mode:      string,
    @Query('hub.verify_token') token:     string,
    @Query('hub.challenge')    challenge: string,
  ): string {
    const expected = this.cfg.get<string>('WHATSAPP_VERIFY_TOKEN', '');
    if (mode === 'subscribe' && token === expected) {
      this.logger.log('Webhook verified');
      return challenge;
    }
    throw new ForbiddenException('Webhook verification failed');
  }

  // ── POST: Inbound WhatsApp messages & statuses ────────────────────────────
  @Post('whatsapp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Inbound WhatsApp messages and delivery statuses' })
  async handleWhatsApp(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature: string,
  ) {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    const rawText = rawBody.toString('utf8');

    const phoneNumberId = this.webhook.extractPhoneNumberId(rawText);
    const appSecret     = await this.webhook.resolveAppSecret(phoneNumberId);

    if (!this.webhook.verifySignature(rawBody, signature, appSecret)) {
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
            await this.webhook.processChangeValue(change.value).catch(err =>
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

  // ── POST: Razorpay payment webhook ────────────────────────────────────────
  @Post('razorpay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Razorpay payment webhook' })
  async handleRazorpay(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-razorpay-signature') sig: string,
  ) {
    const rawBody = req.rawBody
      ? req.rawBody.toString('utf8')
      : JSON.stringify(req.body);
    return this.billing.handleRazorpayWebhook(rawBody, sig ?? '');
  }

  // ── POST: Stripe payment webhook ──────────────────────────────────────────
  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stripe payment webhook' })
  async handleStripe(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('stripe-signature') sig: string,
  ) {
    const rawBody = req.rawBody
      ? req.rawBody.toString('utf8')
      : JSON.stringify(req.body);
    return this.billing.handleStripeWebhook(rawBody, sig ?? '');
  }
}
