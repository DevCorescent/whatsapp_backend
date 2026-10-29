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

function allowedOrigins(): (string | RegExp)[] | boolean {
  const list = (process.env.FRONTEND_URL ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.length === 0) return true;
  return [...list, /^https?:\/\/localhost(:\d+)?$/];
}

@WebSocketGateway({
  namespace:  REALTIME_NAMESPACE,
  cors:       { origin: allowedOrigins(), credentials: false },
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
