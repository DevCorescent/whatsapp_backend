import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

/** One shared ioredis client for the process; `duplicate()` for SUBSCRIBE-mode connections. */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;
  private readonly extras: Redis[] = [];

  constructor(cfg: ConfigService) {
    this.client = new Redis(redisOptions(cfg));
    this.client.on('error', (err) => this.logger.warn(`Redis error: ${err.message}`));
  }

  duplicate(): Redis {
    const dup = this.client.duplicate();
    dup.on('error', (err) => this.logger.warn(`Redis (dup) error: ${err.message}`));
    this.extras.push(dup);
    return dup;
  }

  async onModuleDestroy() {
    await Promise.allSettled([this.client, ...this.extras].map(r => r.quit()));
  }
}

export function redisOptions(cfg: ConfigService): RedisOptions {
  const host     = cfg.get<string>('REDIS_HOST', 'localhost');
  const port     = Number(cfg.get<number>('REDIS_PORT', 6379));
  const password = cfg.get<string>('REDIS_PASSWORD') || undefined;
  const tls      = cfg.get<string>('REDIS_TLS') === 'true' ? { servername: host } : undefined;
  return {
    host, port, password, tls,
    maxRetriesPerRequest: null,
    enableReadyCheck:     false,
    connectTimeout:       10_000,
    retryStrategy:        (times) => Math.min(times * 200, 5_000),
  };
}
