import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

function makeRedis(cfg: ConfigService): Redis {
  const host     = cfg.get<string>('REDIS_HOST', 'localhost');
  const port     = cfg.get<number>('REDIS_PORT', 6379);
  const password = cfg.get<string>('REDIS_PASSWORD') || undefined;
  const tls      = cfg.get<string>('REDIS_TLS') === 'true' ? { servername: host } : undefined;
  return new Redis({
    host, port, password, tls,
    maxRetriesPerRequest: null,
    enableReadyCheck:     false,
    connectTimeout:       10_000,
  });
}

@Injectable()
export class RedisPubSubService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisPubSubService.name);
  private pub!: Redis;

  constructor(private readonly cfg: ConfigService) {}

  onModuleInit() {
    this.pub = makeRedis(this.cfg);
    this.pub.on('error', (err) => this.logger.warn(`Redis pub error: ${err.message}`));
  }

  async onModuleDestroy() {
    await this.pub.quit().catch(() => {});
  }

  async publish(tenantId: string, data: Record<string, unknown>): Promise<void> {
    const channel = `tenant:${tenantId}`;
    const payload = JSON.stringify(data);
    this.logger.log(`[Redis] PUBLISH channel=${channel} event=${data.event ?? '?'} payload=${payload}`);
    try {
      const receivers = await this.pub.publish(channel, payload);
      this.logger.log(`[Redis] PUBLISH delivered to ${receivers} subscriber(s) on channel=${channel}`);
    } catch (err: any) {
      this.logger.error(`[Redis] PUBLISH FAILED channel=${channel}: ${err.message}`);
    }
  }

  /** Each SSE client gets its own subscriber connection (SUBSCRIBE mode is exclusive). */
  createSubscriber(): Redis {
    const sub = makeRedis(this.cfg);
    sub.on('connect',   ()    => this.logger.log('[Redis] subscriber connected'));
    sub.on('ready',     ()    => this.logger.log('[Redis] subscriber ready'));
    sub.on('error',     (err) => this.logger.warn(`[Redis] sub error: ${err.message}`));
    sub.on('end',       ()    => this.logger.log('[Redis] subscriber connection closed'));
    return sub;
  }
}
