import {
  Controller, Get, Post, Put, Delete, Body, Query, UseGuards, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope, NotificationsService, mergePrefs } from '@lib/common';
import { PrismaService } from '@lib/prisma';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly svc:    NotificationsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Notifications for the current user, newest first (cursor paginated)' })
  async list(
    @CurrentTenant() scope: TenantScope,
    @Query('cursor') cursor?: string,
    @Query('limit')  limit?: string,
  ) {
    const take = Math.min(50, Math.max(1, Number(limit) || 20));
    const [items, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where:   { userId: scope.userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take:    take + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      this.svc.unreadCount(scope.userId),
    ]);
    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    return { items: page, nextCursor: hasMore ? page[page.length - 1].id : null, unread };
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark notifications read ({ ids } or { all: true })' })
  async markRead(@CurrentTenant() scope: TenantScope, @Body() body: { ids?: string[]; all?: boolean }) {
    const where = body?.all
      ? { userId: scope.userId, readAt: null }
      : { userId: scope.userId, readAt: null, id: { in: Array.isArray(body?.ids) ? body.ids.slice(0, 200) : [] } };
    const result = await this.prisma.notification.updateMany({ where, data: { readAt: new Date() } });
    return { updated: result.count, unread: await this.svc.unreadCount(scope.userId) };
  }

  @Get('prefs')
  @ApiOperation({ summary: 'Notification preferences for the current user' })
  async getPrefs(@CurrentTenant() scope: TenantScope) {
    const user = await this.prisma.user.findUnique({ where: { id: scope.userId }, select: { notificationPrefs: true } });
    return mergePrefs(user?.notificationPrefs);
  }

  @Put('prefs')
  @ApiOperation({ summary: 'Save notification preferences' })
  async savePrefs(@CurrentTenant() scope: TenantScope, @Body() body: unknown) {
    const prefs = mergePrefs(body);
    await this.prisma.user.update({ where: { id: scope.userId }, data: { notificationPrefs: prefs as any } });
    return prefs;
  }

  @Get('vapid-public-key')
  @ApiOperation({ summary: 'Public VAPID key for web push subscriptions (null when push is disabled)' })
  vapid() {
    return { publicKey: this.svc.vapidPublicKey };
  }

  @Post('push')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Register this browser for web push' })
  async subscribe(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }; userAgent?: string },
  ) {
    const sub = body?.subscription;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw new BadRequestException('Invalid push subscription');
    await this.prisma.pushSubscription.upsert({
      where:  { endpoint: sub.endpoint },
      create: { userId: scope.userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: body.userAgent?.slice(0, 255) ?? null },
      update: { userId: scope.userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: body.userAgent?.slice(0, 255) ?? null },
    });
    return { subscribed: true };
  }

  @Delete('push')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove this browser from web push' })
  async unsubscribe(@CurrentTenant() scope: TenantScope, @Body() body: { endpoint?: string }) {
    if (!body?.endpoint) throw new BadRequestException('endpoint is required');
    await this.prisma.pushSubscription.deleteMany({ where: { userId: scope.userId, endpoint: body.endpoint } });
    return { subscribed: false };
  }
}
