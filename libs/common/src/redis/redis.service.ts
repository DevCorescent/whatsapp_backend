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

/**
 * One Redis connection per role, shared by every queue in a process.
 *
 * Bull opens three connections for each queue it manages. A handful of queues and the
 * process is holding twenty-odd, which a managed Redis will not allow for long — the
 * hosted free tier stops at thirty — so a restart that overlaps the previous instance
 * is refused with "max number of clients reached", and the new process dies on it.
 *
 * `client` and `subscriber` are safe to share: Bull only issues ordinary commands on the
 * first and only subscribes on the second. `bclient` is not, because it issues blocking
 * reads — a queue waiting there would hold up every other queue sharing the socket — so
 * those stay one per processor.
 *
 * Every connection gets an error listener. Without one, ioredis re-emits a connection
 * error as an uncaught exception, which takes the whole process down for something it
 * would otherwise retry through.
 */
export function sharedBullClients(options: RedisOptions, logger?: Logger) {
  let shared: Partial<Record<'client' | 'subscriber', Redis>> = {};

  const make = (role: string): Redis => {
    const conn = new Redis(options);
    conn.on('error', (err) => logger?.warn(`Redis (${role}) error: ${err.message}`));
    return conn;
  };

  return (type: 'client' | 'subscriber' | 'bclient'): Redis => {
    if (type === 'bclient') return make('bclient');
    return (shared[type] ??= make(type));
  };
}
