import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import * as crypto from 'crypto';

@Injectable()
export class WebhookDispatchService {
  private readonly logger = new Logger(WebhookDispatchService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Fire an event to all active webhook endpoints subscribed to `event`.
   * Never throws — errors are logged and swallowed.
   */
  async dispatchEvent(tenantId: string, event: string, data: Record<string, unknown>): Promise<void> {
    try {
      const endpoints = await this.prisma.webhookEndpoint.findMany({
        where: { tenantId, isActive: true, events: { has: event } },
      });
      if (!endpoints.length) return;

      const payload = JSON.stringify({ event, ts: new Date().toISOString(), data });
      await Promise.allSettled(endpoints.map(ep => this.deliver(ep, event, payload)));
    } catch (err) {
      this.logger.error(`dispatchEvent(${event}) error: ${(err as Error).message}`);
    }
  }

  private async deliver(
    ep: { id: string; url: string; secret: string },
    event: string,
    payloadJson: string,
  ) {
    const sig = crypto.createHmac('sha256', ep.secret).update(payloadJson).digest('hex');
    const start = Date.now();
    let statusCode: number | undefined;
    let responseText: string | undefined;
    let errorText: string | undefined;

    try {
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `sha256=${sig}`,
          'X-Webhook-Event': event,
        },
        body: payloadJson,
        signal: AbortSignal.timeout(10_000),
      });
      statusCode = res.status;
      responseText = (await res.text()).slice(0, 2000);
    } catch (err) {
      errorText = (err as Error).message;
    }

    await this.prisma.webhookDelivery.create({
      data: {
        endpointId:  ep.id,
        event,
        payload:     JSON.parse(payloadJson),
        statusCode,
        response:    responseText,
        error:       errorText,
        attempts:    1,
        deliveredAt: statusCode && statusCode < 300 ? new Date() : null,
      },
    }).catch(() => {});

    this.logger.debug(`Webhook ${event} → ${ep.url} [${statusCode ?? 'ERR'}] ${Date.now() - start}ms`);
  }
}
