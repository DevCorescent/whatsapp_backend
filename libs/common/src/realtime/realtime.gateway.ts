import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, MessageBody,
  ConnectedSocket, WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { rooms, type RealtimeClientEvents } from './events';

export interface SocketIdentity {
  userId:     string;
  tenantId:   string;
  businessId: string;
  role:       string;
  visible:    boolean;
}

export const REALTIME_NAMESPACE = '/rt';

/**
 * Whether a page at this origin may open a socket.
 *
 * The browser connects to this server directly rather than through the app's own
 * origin, so every address the app is served from has to be allowed — and that is more
 * than one. FRONTEND_URL takes a comma-separated list, and a white-label reseller is
 * served from its own subdomain of the platform root. Without that last case a brand's
 * dashboard loads perfectly and then silently never receives an event, because the
 * socket is the only cross-origin request it makes.
 *
 * A reseller's own custom domain cannot be known from configuration, so it belongs in
 * FRONTEND_URL alongside the rest.
 */
function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function originAllowed(origin: string | undefined, cb: (err: Error | null, ok?: boolean) => void) {
  // Same-origin requests and non-browser clients send no Origin at all.
  if (!origin) return cb(null, true);

  const list = (process.env.FRONTEND_URL ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return cb(null, true);
  if (list.includes(origin)) return cb(null, true);

  const host = hostOf(origin);
  if (host === 'localhost' || host === '127.0.0.1') return cb(null, true);

  const root = (process.env.PLATFORM_ROOT_DOMAIN ?? '').trim().toLowerCase();
  if (root && (host === root || host.endsWith('.' + root))) return cb(null, true);

  return cb(null, false);
}

@WebSocketGateway({
  namespace:  REALTIME_NAMESPACE,
  cors:       { origin: originAllowed, credentials: false },
  transports: ['websocket', 'polling'],
  pingInterval: 25_000,
  pingTimeout:  20_000,
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer() server!: Server;

  constructor(private readonly jwt: JwtService) {}

  handleConnection(socket: Socket) {
    const token = socket.handshake.auth?.token as string | undefined;
    let payload: { sub: string; tenantId: string; businessId: string; role: string };
    try {
      if (!token) throw new Error('missing token');
      payload = this.jwt.verify(token);
    } catch (err: any) {
      this.logger.warn(`WS rejected: ${err?.message ?? err}`);
      socket.emit('error', { message: 'unauthorized' });
      socket.disconnect(true);
      return;
    }
    if (!payload.sub || !payload.tenantId) {
      socket.disconnect(true);
      return;
    }

    const identity: SocketIdentity = {
      userId:     payload.sub,
      tenantId:   payload.tenantId,
      businessId: payload.businessId ?? '',
      role:       payload.role,
      visible:    true,
    };
    socket.data = identity;

    void socket.join(rooms.tenant(identity.tenantId));
    void socket.join(rooms.user(identity.userId));
    if (identity.businessId) void socket.join(rooms.business(identity.businessId));

    this.logger.log(`WS connected user=${identity.userId} business=${identity.businessId || '-'} sid=${socket.id}`);
  }

  handleDisconnect(socket: Socket) {
    const id = socket.data as Partial<SocketIdentity>;
    if (id?.userId) this.logger.log(`WS disconnected user=${id.userId} sid=${socket.id}`);
  }

  @SubscribeMessage('presence')
  onPresence(@ConnectedSocket() socket: Socket, @MessageBody() body: RealtimeClientEvents['presence']) {
    (socket.data as SocketIdentity).visible = Boolean(body?.visible);
  }
}
