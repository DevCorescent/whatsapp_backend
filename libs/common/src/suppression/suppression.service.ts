import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';

/** Digits only, the way contacts and blacklist entries are both stored. */
function digits(phone: string): string {
  return phone.replace(/\D/g, '');
}

export interface SuppressInput {
  tenantId: string;
  businessId?: string | null;
  phone: string;
  /** The WhatsApp error code that proved it, when there was one. */
  errorCode?: number | null;
  reason: string;
}

/**
 * The list of people we must not message again.
 *
 * WhatsApp tells us someone has opted out in two ways: error 131050 when a send is
 * attempted, and the `user_preferences` webhook the moment they change the setting. Both
 * end up here, because a campaign launched tomorrow has to know about it just as much as
 * the one running now.
 *
 * Two records are written, which is deliberate. The contact is marked opted out, which is
 * what the launch filter and the contact screen already read. A blacklist entry is added
 * as well, because a broadcast can be sent to raw numbers that were never saved as
 * contacts, and without the entry nothing would stop those.
 */
@Injectable()
export class SuppressionService {
  private readonly logger = new Logger(SuppressionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stop sending marketing to this number. Safe to call repeatedly — a number already
   * suppressed is left as it is, and `false` comes back so a caller does not double-count.
   */
  async suppress(input: SuppressInput): Promise<boolean> {
    const phone = digits(input.phone);
    if (!phone) return false;

    try {
      const existing = await this.prisma.blacklistEntry.findUnique({
        where: { tenantId_phone: { tenantId: input.tenantId, phone } },
      });

      if (!existing) {
        await this.prisma.blacklistEntry.create({
          data: {
            tenantId:  input.tenantId,
            phone,
            reason:    input.reason.slice(0, 500),
            source:    'OPT_OUT',
            errorCode: input.errorCode ?? null,
          },
        });
      } else if (existing.source === 'MANUAL') {
        // Someone had already blocked this number by hand. Leave their reason alone.
        return false;
      }

      // Any contact row holding this number, in whichever business it lives.
      const marked = await this.prisma.contact.updateMany({
        where: {
          tenantId: input.tenantId,
          phone,
          optedOut: false,
          ...(input.businessId ? { businessId: input.businessId } : {}),
        },
        data: { optedOut: true },
      });

      this.logger.log(
        `Suppressed ${phone} for tenant ${input.tenantId} (${input.errorCode ?? 'webhook'}), ${marked.count} contact row(s)`,
      );
      return !existing;
    } catch (err) {
      // Never let bookkeeping fail a send path. The worst case is one more attempt later.
      this.logger.error(`Could not suppress ${phone}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * They have opted back in. Only the automatic entry is removed: a number a person
   * blocked by hand stays blocked, because that was a separate decision.
   */
  async resume(tenantId: string, phone: string): Promise<boolean> {
    const normalised = digits(phone);
    if (!normalised) return false;

    try {
      const removed = await this.prisma.blacklistEntry.deleteMany({
        where: { tenantId, phone: normalised, source: 'OPT_OUT' },
      });

      const stillBlocked = await this.prisma.blacklistEntry.count({
        where: { tenantId, phone: normalised },
      });
      if (stillBlocked === 0) {
        await this.prisma.contact.updateMany({
          where: { tenantId, phone: normalised, optedOut: true },
          data:  { optedOut: false },
        });
      }

      this.logger.log(`Resumed ${normalised} for tenant ${tenantId} (${removed.count} opt-out entries cleared)`);
      return removed.count > 0;
    } catch (err) {
      this.logger.error(`Could not resume ${normalised}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Which of these numbers must not be messaged. Used to filter a list before sending. */
  async suppressedAmong(tenantId: string, phones: string[]): Promise<Set<string>> {
    const normalised = [...new Set(phones.map(digits).filter(Boolean))];
    if (!normalised.length) return new Set();

    const entries = await this.prisma.blacklistEntry.findMany({
      where:  { phone: { in: normalised }, OR: [{ tenantId }, { tenantId: null }] },
      select: { phone: true },
    });
    return new Set(entries.map((e) => e.phone));
  }
}
