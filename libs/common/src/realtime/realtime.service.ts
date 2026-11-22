import { Injectable, Logger } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import { RedisService } from '../redis/redis.service';
import { RealtimeGateway, REALTIME_NAMESPACE, type SocketIdentity } from './realtime.gateway';
import { rooms, type PresenceState, type RealtimeEventName, type RealtimeEvents } from './events';

/**
 * The one way the backend talks to connected browsers. Every emit is room-scoped,
 * so a tenant / business / user only ever receives its own events.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private emitter?: Emitter;

  constructor(
    private readonly gateway: RealtimeGateway,
    private readonly redis: RedisService,
  ) {}

  private get server() {
    return this.gateway.server;
  }

  /**
   * How a process with no sockets of its own reaches the browsers.
   *
   * `waboxa-worker` boots through `createApplicationContext` — no HTTP server, so no
   * websocket adapter, so `gateway.server` is undefined there and every emit from a queue
   * processor or a cron returned silently. Nothing was lost yet only because the live
   * inbound and auto-reply path runs inside the gateway; the first job moved out of it
   * would have gone quiet with no error to find.
   *
   * The emitter writes straight into the same Redis channel `@socket.io/redis-adapter`
   * listens on, so the gateways deliver it exactly once between them. Publishing on a
   * channel of our own and re-emitting in each gateway would have sent one event per
   * instance to every browser.
   */
  private get emitTarget() {
    if (this.server) return this.server;
    if (!this.emitter) {
      this.emitter = new Emitter(this.redis.client).of(REALTIME_NAMESPACE);
      this.logger.log(`No local socket server — emitting through Redis on ${REALTIME_NAMESPACE}`);
    }
    return this.emitter;
  }

  private emit(room: string, event: RealtimeEventName, payload: unknown) {
    try {
      this.emitTarget.to(room).emit(event, payload);
    } catch (err: any) {
      this.logger.warn(`emit ${event} → ${room} failed: ${err?.message ?? err}`);
    }
  }

  toBusiness<E extends RealtimeEventName>(businessId: string, event: E, payload: RealtimeEvents[E]) {
    if (businessId) this.emit(rooms.business(businessId), event, payload);
  }

  toTenant<E extends RealtimeEventName>(tenantId: string, event: E, payload: RealtimeEvents[E]) {
    this.emit(rooms.tenant(tenantId), event, payload);
  }

  toUser<E extends RealtimeEventName>(userId: string, event: E, payload: RealtimeEvents[E]) {
    this.emit(rooms.user(userId), event, payload);
  }

  toUsers<E extends RealtimeEventName>(userIds: string[], event: E, payload: RealtimeEvents[E]) {
    for (const id of new Set(userIds)) this.toUser(id, event, payload);
  }


  /**
   * What a teammate's dot should say, from the two halves that decide it.
   *
   * Connectivity is read from the sockets, never from a column: a laptop closing does
   * not get to write a row, so a stored "online" would be a claim nobody ever retracts.
   * The chosen status is read from the row, because it must survive a reload and be
   * visible to someone who was not connected when it was set.
   *
   * One function so the gateway, the REST reply and the broadcast cannot disagree about
   * the same person at the same moment.
   */
  presenceFor(online: boolean, visible: boolean, override?: string | null): PresenceState {
    if (override === 'BUSY' || override === 'AWAY') return override;
    if (!online) return 'OFFLINE';
    return visible ? 'ONLINE' : 'AWAY';
  }

  /** True when the user has at least one connected socket whose tab is visible. */
  async isUserActive(userId: string): Promise<boolean> {
    if (!this.server) return false;
    try {
      const sockets = await this.server.in(rooms.user(userId)).fetchSockets();
      return sockets.some(s => (s.data as SocketIdentity)?.visible);
    } catch {
      return false;
    }
  }

  /** Users with any open socket in this business (visible or not). */
  async onlineUsersInBusiness(businessId: string): Promise<Set<string>> {
    const out = new Set<string>();
    if (!this.server) return out;
    try {
      const sockets = await this.server.in(rooms.business(businessId)).fetchSockets();
      for (const s of sockets) {
        const id = (s.data as SocketIdentity)?.userId;
        if (id) out.add(id);
      }
    } catch { /* adapter unavailable → treat as nobody online */ }
    return out;
  }
}
