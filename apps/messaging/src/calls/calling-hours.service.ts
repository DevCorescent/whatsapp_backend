import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '@lib/prisma';
import { decryptSecret } from '@lib/common';
import { MetaCallsClient, MetaCallError } from './meta-calls.client';

/**
 * Switches a number's calling on and off to match its department's business hours.
 *
 * Calling is unlike messaging: a missed call is a worse experience than a message that
 * waits, so a business that only staffs its phones in the day should not show a call
 * button at midnight. The department already states its hours for exactly this kind of
 * question, so they are reused rather than asking twice.
 *
 * Meta holds the live setting, so this reconciles rather than commands: it works out
 * what the setting should be, compares it with what we last saw, and only calls Meta
 * when the two disagree. That keeps the number of Graph calls to roughly two a day per
 * number instead of one every time the scheduler runs.
 */
@Injectable()
export class CallingHoursService {
  private readonly logger = new Logger(CallingHoursService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta:   MetaCallsClient,
  ) {}

  /**
   * Whether the given moment falls inside the department's working hours.
   *
   * Hours are read in the department's own timezone, not the server's — a business in
   * Kolkata keeps Kolkata hours whichever region this happens to be deployed in.
   * An end time earlier than the start is read as running past midnight.
   */
  isWithinHours(
    business: { timezone: string; businessHoursStart: string; businessHoursEnd: string; businessDays: number[] },
    now = new Date(),
  ): boolean {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: business.timezone || 'Asia/Kolkata',
      weekday:  'short',
      hour:     '2-digit',
      minute:   '2-digit',
      hour12:   false,
    }).formatToParts(now);

    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    const minutes = Number(get('hour')) * 60 + Number(get('minute'));

    const days = business.businessDays?.length ? business.businessDays : [1, 2, 3, 4, 5];
    if (!days.includes(weekday)) return false;

    const toMinutes = (hhmm: string) => {
      const [h, m] = (hhmm || '').split(':').map(Number);
      return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
    };
    const start = toMinutes(business.businessHoursStart) ?? 9 * 60;
    const end   = toMinutes(business.businessHoursEnd) ?? 18 * 60;

    // A shift that ends before it starts runs through midnight.
    return end >= start ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcile() {
    const integrations = await this.prisma.whatsAppIntegration.findMany({
      where: { callingFollowsBusinessHours: true, isActive: true },
      select: {
        id: true, phoneNumberId: true, accessToken: true, callingEnabled: true, displayName: true,
        business: {
          select: {
            timezone: true, businessHoursStart: true, businessHoursEnd: true, businessDays: true,
          },
        },
      },
    });
    if (!integrations.length) return;

    for (const integration of integrations) {
      const shouldBeOn = this.isWithinHours(integration.business);
      if (shouldBeOn === integration.callingEnabled) continue;

      const token = integration.accessToken ? decryptSecret(integration.accessToken) : null;
      if (!token) {
        this.logger.warn(`${integration.displayName ?? integration.phoneNumberId} has no usable token; skipping`);
        continue;
      }

      try {
        await this.meta.setCalling(integration.phoneNumberId, token, shouldBeOn);
        await this.prisma.whatsAppIntegration.update({
          where: { id: integration.id },
          data:  { callingEnabled: shouldBeOn },
        });
        this.logger.log(
          `Calling ${shouldBeOn ? 'opened' : 'closed'} for ${integration.displayName ?? integration.phoneNumberId} (business hours)`,
        );
      } catch (err) {
        // One number's failure must not stop the rest; it is retried in five minutes.
        const why = err instanceof MetaCallError ? err.message : (err as Error).message;
        this.logger.error(`Could not change calling for ${integration.phoneNumberId}: ${why}`);
      }
    }
  }
}
