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
    try {
      await this.pub.publish(`tenant:${tenantId}`, JSON.stringify(data));
    } catch (err: any) {
      this.logger.warn(`Redis publish failed for tenant ${tenantId}: ${err.message}`);
    }
  }

  /** Each SSE client gets its own subscriber connection (SUBSCRIBE mode is exclusive). */
  createSubscriber(): Redis {
    const sub = makeRedis(this.cfg);
    sub.on('error', (err) => this.logger.warn(`Redis sub error: ${err.message}`));
    return sub;
  }
}
