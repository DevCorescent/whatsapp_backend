import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { PrismaService } from '@lib/prisma';
import { RealtimeService } from '../realtime/realtime.service';
import type { RtNotification } from '../realtime/events';
import { EVENT_FOR_TYPE, mergePrefs, type NotificationPrefs } from './notification-prefs';

export type NotificationRecipients =
  | { userIds: string[] }
  | { roles: string[]; excludeUserIds?: string[] };

export interface NotifyInput {
  tenantId:    string;
  businessId?: string | null;
  recipients:  NotificationRecipients;
  type:        'NEW_MESSAGE' | 'MISSED_CALL' | 'CAMPAIGN_COMPLETED' | 'CONVERSATION_ASSIGNED' | 'LEAD_ASSIGNED' | 'SYSTEM';
  title:       string;
  body?:       string | null;
  href?:       string | null;
  data?:       Record<string, unknown>;
  /** Collapses repeats (e.g. several messages in one conversation) into one unread row per user. */
  dedupeKey?:  string;
}

/** Everyone who should hear about customer activity by default (UserRole enum values only). */
export const AGENT_ROLES = ['TENANT_OWNER', 'ADMIN', 'MANAGER', 'AGENT'];
export const MANAGER_ROLES = ['TENANT_OWNER', 'ADMIN', 'MANAGER', 'MARKETING_USER'];

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly pushReady: boolean;

  constructor(
    private readonly prisma:   PrismaService,
    private readonly realtime: RealtimeService,
    cfg: ConfigService,
  ) {
    const pub  = cfg.get<string>('VAPID_PUBLIC_KEY');
    const priv = cfg.get<string>('VAPID_PRIVATE_KEY');
    const subj = cfg.get<string>('VAPID_SUBJECT') || 'mailto:support@example.com';
    this.pushReady = Boolean(pub && priv);
    if (this.pushReady) webpush.setVapidDetails(subj, pub!, priv!);
    else this.logger.warn('Web push disabled — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY');
  }

  get vapidPublicKey(): string | null {
    return process.env.VAPID_PUBLIC_KEY || null;
  }

  async notify(input: NotifyInput): Promise<void> {
    try {
      const users = await this.resolveRecipients(input);
      await Promise.all(users.map(u => this.notifyOne(input, u)));
    } catch (err: any) {
      this.logger.warn(`notify(${input.type}) failed: ${err?.message ?? err}`);
    }
  }

  private async resolveRecipients(input: NotifyInput) {
    const where = 'userIds' in input.recipients
      ? { id: { in: input.recipients.userIds }, tenantId: input.tenantId, isActive: true }
      : {
          tenantId: input.tenantId, isActive: true,
          role: { in: input.recipients.roles as any },
          ...(input.recipients.excludeUserIds?.length ? { id: { notIn: input.recipients.excludeUserIds } } : {}),
        };
    return this.prisma.user.findMany({ where, select: { id: true, notificationPrefs: true } });
  }

  private async notifyOne(input: NotifyInput, user: { id: string; notificationPrefs: unknown }) {
    const prefs: NotificationPrefs = mergePrefs(user.notificationPrefs);
    const event = EVENT_FOR_TYPE[input.type];
    const channel = event ? prefs[event] : { inApp: true, desktop: true, sound: false, email: false };
    if (!channel.inApp && !channel.desktop) return;

    const data = { ...(input.data ?? {}), ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}) };
    let row: { id: string; createdAt: Date } | null = null;
    let updated = false;

    if (input.dedupeKey) {
      const existing = await this.prisma.notification.findFirst({
        where: { userId: user.id, readAt: null, type: input.type, data: { path: ['dedupeKey'], equals: input.dedupeKey } },
        select: { id: true },
      });
      if (existing) {
        row = await this.prisma.notification.update({
          where: { id: existing.id },
          data:  { title: input.title, body: input.body ?? null, href: input.href ?? null, data: data as any, createdAt: new Date() },
          select: { id: true, createdAt: true },
        });
        updated = true;
      }
    }
    if (!row) {
      row = await this.prisma.notification.create({
        data: {
          tenantId: input.tenantId, businessId: input.businessId ?? null, userId: user.id,
          type: input.type, title: input.title, body: input.body ?? null, href: input.href ?? null, data: data as any,
        },
        select: { id: true, createdAt: true },
      });
    }

    const dto: RtNotification = {
      id: row.id, type: input.type, title: input.title, body: input.body ?? null, href: input.href ?? null,
      businessId: input.businessId ?? null, data, readAt: null, createdAt: row.createdAt.toISOString(),
    };

    if (channel.inApp) {
      this.realtime.toUser(user.id, updated ? 'notification:updated' : 'notification:new', dto);
      this.realtime.toUser(user.id, 'notification:count', { unread: await this.unreadCount(user.id) });
    }
    if (channel.desktop) await this.push(user.id, dto);
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  /** Sends to every subscription the user has; the service worker decides whether to show it. */
  private async push(userId: string, n: RtNotification) {
    if (!this.pushReady) return;
    const subs = await this.prisma.pushSubscription.findMany({ where: { userId } });
    if (subs.length === 0) return;
    const payload = JSON.stringify({ id: n.id, title: n.title, body: n.body, href: n.href, tag: (n.data?.dedupeKey as string | undefined) ?? n.id, type: n.type });
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 300 });
        await this.prisma.pushSubscription.update({ where: { id: s.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
      } catch (err: any) {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          await this.prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
        } else {
          this.logger.warn(`push to ${s.endpoint.slice(0, 40)}… failed: ${status ?? err?.message}`);
        }
      }
    }));
  }
}
