import { Controller, Get, Logger, MessageEvent, Request, Sse, UseGuards } from '@nestjs/common';
import { Observable } from 'rxjs';
import { JwtAuthGuard, RedisPubSubService } from '@lib/common';

@Controller('events')
export class EventsController {
  private readonly logger = new Logger(EventsController.name);

  constructor(private readonly pubSub: RedisPubSubService) {}

  /**
   * SSE stream scoped to the caller's tenant.
   * Browser connects once; Redis pub/sub pushes events as they arrive.
   * A keepalive ping fires every 25 s to prevent proxy/load-balancer timeouts.
   */
  @Sse()
  @UseGuards(JwtAuthGuard)
  stream(@Request() req: any): Observable<MessageEvent> {
    const tenantId = req.user?.tenantId as string;
    const userId   = req.user?.id as string;
    this.logger.log(`[SSE] client connected tenantId=${tenantId} userId=${userId}`);

    return new Observable((subscriber) => {
      const channel = `tenant:${tenantId}`;
      const sub     = this.pubSub.createSubscriber();

      sub.subscribe(channel, (err, count) => {
        if (err) {
          this.logger.error(`[SSE] Redis SUBSCRIBE failed channel=${channel}: ${err.message}`);
        } else {
          this.logger.log(`[SSE] Subscribed to channel=${channel} total_subscriptions=${count}`);
        }
      });

      sub.on('message', (_ch: string, message: string) => {
        this.logger.log(`[SSE] Redis message on channel=${_ch} payload=${message}`);
        try {
          const parsed = JSON.parse(message);
          this.logger.log(`[SSE] Forwarding event=${parsed.event ?? '?'} to tenantId=${tenantId}`);
          subscriber.next({ data: parsed } as MessageEvent);
        } catch (err: any) {
          this.logger.warn(`[SSE] Bad JSON from Redis: ${message} — ${err.message}`);
        }
      });

      // Send a ping every 25 s so the connection survives idle timeouts.
      const ping = setInterval(() => {
        subscriber.next({ data: { event: 'ping' } } as MessageEvent);
      }, 25_000);

      // Teardown: called when the client disconnects or the observable is unsubscribed.
      return () => {
        this.logger.log(`[SSE] client disconnected tenantId=${tenantId} userId=${userId}`);
        clearInterval(ping);
        sub.unsubscribe(channel).finally(() => sub.quit().catch(() => {}));
      };
    });
  }
}
