import { Injectable, Logger } from '@nestjs/common';
import { RealtimeGateway, type SocketIdentity } from './realtime.gateway';
import { rooms, type RealtimeEventName, type RealtimeEvents } from './events';

/**
 * The one way the backend talks to connected browsers. Every emit is room-scoped,
 * so a tenant / business / user only ever receives its own events.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);

  constructor(private readonly gateway: RealtimeGateway) {}

  private get server() {
    return this.gateway.server;
  }

  private emit(room: string, event: RealtimeEventName, payload: unknown) {
    if (!this.server) return;
    try {
      this.server.to(room).emit(event, payload);
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
