import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { PrismaService } from '@lib/prisma';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Get recent notifications (audit logs + new messages)' })
  async getNotifications(@CurrentTenant() scope: TenantScope) {
    const [logs, newMessages] = await Promise.all([
      this.prisma.auditLog.findMany({
        where:   { tenantId: scope.tenantId },
        orderBy: { createdAt: 'desc' },
        take:    15,
        select: {
          id: true, action: true, resource: true, resourceId: true, createdAt: true,
          user: { select: { name: true, avatar: true } },
        },
      }),
      this.prisma.message.findMany({
        where:   { tenantId: scope.tenantId, direction: 'INBOUND' },
        orderBy: { createdAt: 'desc' },
        take:    5,
        select: {
          id: true, content: true, createdAt: true,
          conversation: { select: { contact: { select: { name: true, avatarUrl: true } } } },
        },
      }),
    ]);

    const msgNotifications = newMessages.flatMap((m) => {
      const contact = m.conversation?.contact;
      if (!contact) return [];
      return [{
        id:        `msg-${m.id}`,
        type:      'message',
        title:     `New message from ${contact.name}`,
        body:      (m.content ?? 'Media message').slice(0, 80),
        avatar:    contact.avatarUrl ?? null,
        createdAt: m.createdAt,
        href:      '/inbox',
      }];
    });

    const logNotifications = logs.map((l) => ({
      id:        `log-${l.id}`,
      type:      'activity',
      title:     l.action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      body:      `${l.resource} updated`,
      avatar:    (l.user as any)?.avatar ?? null,
      createdAt: l.createdAt,
      href:      null,
    }));

    const notifications = [...msgNotifications, ...logNotifications]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 20);

    // Return flat array in data to match Next.js /api/notifications shape
    return { success: true, data: notifications };
  }
}
