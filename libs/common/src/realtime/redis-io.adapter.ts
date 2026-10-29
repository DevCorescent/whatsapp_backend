import { INestApplicationContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { ServerOptions } from 'socket.io';
import { redisOptions } from '../redis/redis.service';

/** Socket.IO adapter backed by Redis so emits reach sockets on every gateway instance. */
export class RedisIoAdapter extends IoAdapter {
  private readonly log = new Logger(RedisIoAdapter.name);
  private adapterCtor?: ReturnType<typeof createAdapter>;

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const cfg = this.app.get(ConfigService);
    const pub = new Redis(redisOptions(cfg));
    const sub = pub.duplicate();
    for (const c of [pub, sub]) c.on('error', (err) => this.log.warn(`Redis adapter error: ${err.message}`));
    this.adapterCtor = createAdapter(pub, sub);
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    if (this.adapterCtor) server.adapter(this.adapterCtor);
    return server;
  }
}
