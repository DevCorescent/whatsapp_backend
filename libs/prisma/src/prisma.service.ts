import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Errors that mean "the connection was not there", rather than "the query was wrong".
 *
 * P1001 is the one that matters on a serverless Postgres: the compute suspends when idle
 * and a pooled socket can be closed underneath us, so the next query fails once and the
 * one after it succeeds.
 */
const TRANSIENT_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);

export function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return typeof code === 'string' && TRANSIENT_CODES.has(code);
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const adapter = new PrismaPg({
      connectionString: process.env['DATABASE_URL'],
      // A serverless Postgres sits behind a pooler that drops quiet connections, and the
      // default pool gives one up after ten seconds. Anything on a slower rhythm than
      // that — the once-a-minute schedulers above all — then pays a fresh TLS handshake
      // every time, which is both slow and the moment a connection error happens.
      // Holding the socket open across those gaps costs nothing and avoids the reconnect.
      keepAlive:                  true,
      keepAliveInitialDelayMillis: 10_000,
      idleTimeoutMillis:          90_000,
    });
    super({ adapter });
  }

  async onModuleInit() {
    // A cold serverless database takes a moment to wake, and failing to boot over that
    // would be worse than waiting for it.
    await this.withRetry(() => this.$connect(), 'connect', 3).catch((err) => {
      this.logger.error(`Could not reach the database at startup: ${(err as Error).message.split('\n')[0]}`);
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Runs a query, retrying it if the connection was the problem.
   *
   * Only connection errors are retried, and only a couple of times. A query that is
   * wrong will be wrong again, so retrying it just delays the real error.
   */
  async withRetry<T>(run: () => Promise<T>, label = 'query', attempts = 2): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await run();
      } catch (err) {
        lastError = err;
        if (!isTransientDbError(err) || attempt === attempts) break;
        // Short, growing pause: a dropped socket reconnects immediately, a suspended
        // database needs a second or two.
        const wait = attempt * 1_500;
        this.logger.warn(`Database unreachable on ${label}, retrying in ${wait} ms`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    throw lastError;
  }
}
