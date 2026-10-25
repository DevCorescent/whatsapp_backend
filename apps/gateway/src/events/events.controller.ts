import { Controller, Get, MessageEvent, Request, Sse, UseGuards } from '@nestjs/common';
import { Observable } from 'rxjs';
import { JwtAuthGuard, RedisPubSubService } from '@lib/common';

@Controller('events')
export class EventsController {
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

    return new Observable((subscriber) => {
      const channel = `tenant:${tenantId}`;
      const sub     = this.pubSub.createSubscriber();

      sub.subscribe(channel);

      sub.on('message', (_ch: string, message: string) => {
        try {
          subscriber.next({ data: JSON.parse(message) } as MessageEvent);
        } catch { /* ignore bad JSON */ }
      });

      // Send a ping every 25 s so the connection survives idle timeouts.
      const ping = setInterval(() => {
        subscriber.next({ data: { event: 'ping' } } as MessageEvent);
      }, 25_000);

      // Teardown: called when the client disconnects or the observable is unsubscribed.
      return () => {
        clearInterval(ping);
        sub.unsubscribe(channel).finally(() => sub.quit().catch(() => {}));
      };
    });
  }
}
