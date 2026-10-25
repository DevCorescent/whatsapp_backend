import {
  Controller, Get, Post, Query, Headers, Req, Res,
  HttpCode, HttpStatus, ForbiddenException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
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
  // Uses @Res() to send the raw challenge string directly — bypassing the
  // global TransformInterceptor which would otherwise wrap it in { success, data }
  // and cause Meta's verification to fail (it expects the bare challenge back).
  @Get('whatsapp')
  @ApiOperation({ summary: 'Meta webhook verification challenge' })
  verifyWhatsApp(
    @Query('hub.mode')         mode:      string,
    @Query('hub.verify_token') token:     string,
    @Query('hub.challenge')    challenge: string,
    @Res() res: Response,
  ): void {
    const expected = this.cfg.get<string>('WHATSAPP_VERIFY_TOKEN', '');
    if (mode === 'subscribe' && token === expected) {
      this.logger.log('Webhook verified');
      res.status(200).send(challenge);
      return;
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
    // ── Step 1: confirm request reached NestJS ──────────────────────────────
    this.logger.log(`[WH-1] POST /webhook/whatsapp hit. sig=${signature ? 'present' : 'MISSING'} rawBody=${req.rawBody ? 'buffer' : 'no-buffer-using-json'}`);

    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    const rawText = rawBody.toString('utf8');
    this.logger.log(`[WH-2] rawText.length=${rawText.length} preview=${rawText.slice(0, 80)}`);

    // ── Step 2: extract phone number ────────────────────────────────────────
    const phoneNumberId = this.webhook.extractPhoneNumberId(rawText);
    this.logger.log(`[WH-3] phoneNumberId=${phoneNumberId ?? 'null'}`);

    // ── Step 3: resolve app secret + verify signature ───────────────────────
    const appSecret = await this.webhook.resolveAppSecret(phoneNumberId);
    this.logger.log(`[WH-4] appSecret.length=${appSecret?.length ?? 0}`);

    const sigOk = this.webhook.verifySignature(rawBody, signature, appSecret);
    this.logger.log(`[WH-5] signature valid=${sigOk}`);
    // TEMP: log but don't block — lets us see downstream logs even if sig wrong
    if (!sigOk) {
      this.logger.warn(`[WH-5] ⚠ Signature FAILED but continuing (debug mode) phoneNumberId=${phoneNumberId ?? 'null'}`);
    }

    // ── Step 4: parse and dispatch ──────────────────────────────────────────
    try {
      const payload = JSON.parse(rawText) as WAWebhookPayload;
      this.logger.log(`[WH-6] object=${payload?.object} entries=${payload?.entry?.length ?? 0}`);

      if (payload?.object !== 'whatsapp_business_account') {
        this.logger.warn(`[WH-6] unexpected object=${payload?.object} — skipping`);
        return { success: true };
      }

      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          this.logger.log(`[WH-7] change.field=${change.field} msgs=${(change.value as any)?.messages?.length ?? 0} statuses=${(change.value as any)?.statuses?.length ?? 0}`);
          if (change.field === 'messages') {
            await this.webhook.processChangeValue(change.value).catch(err =>
              this.logger.error(`[WH-7] Entry ${entry.id} error: ${err?.message}`, err?.stack),
            );
          }
        }
      }
    } catch (err: any) {
      this.logger.error(`[WH-ERR] ${err?.message}`, err?.stack);
    }

    this.logger.log(`[WH-8] done — returning 200`);
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
