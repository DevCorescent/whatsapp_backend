import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

@Injectable()
export class TicketsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    scope: TenantScope,
    query: { page?: number; limit?: number; status?: string; priority?: string; assignedToId?: string },
  ) {
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const skip  = (page - 1) * limit;

    const where: any = { tenantId: scope.tenantId, businessId: scope.businessId };
    if (query.status)       where.status       = query.status;
    if (query.priority)     where.priority     = query.priority;
    if (query.assignedToId) where.assignedToId = query.assignedToId;

    const [tickets, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          assignedTo:   { select: { name: true } },
          conversation: {
            select: {
              id:      true,
              contact: { select: { name: true, phone: true } },
            },
          },
        },
      }),
      this.prisma.ticket.count({ where }),
    ]);

    return { tickets, total, page, limit };
  }

  async create(
    scope: TenantScope,
    data: {
      subject: string;
      conversationId?: string;
      assignedToId?:   string;
      priority?:       string;
      department?:     string;
      slaDeadline?:    string;
    },
  ) {
    return this.prisma.ticket.create({
      data: {
        tenantId:       scope.tenantId,
        businessId:     scope.businessId,
        subject:        data.subject,
        conversationId: data.conversationId,
        assignedToId:   data.assignedToId,
        priority:       (data.priority ?? 'MEDIUM') as any,
        department:     data.department,
        slaDeadline:    data.slaDeadline ? new Date(data.slaDeadline) : undefined,
        status:         'OPEN',
      },
    });
  }

  async get(scope: TenantScope, id: string) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, tenantId: scope.tenantId, businessId: scope.businessId },
      include: {
        assignedTo:   { select: { id: true, name: true, email: true } },
        conversation: {
          select: {
            id:       true,
            status:   true,
            contact:  { select: { id: true, name: true, phone: true, email: true } },
          },
        },
      },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  async update(
    scope: TenantScope,
    id: string,
    data: {
      status?:       string;
      priority?:     string;
      assignedToId?: string;
      department?:   string;
      slaDeadline?:  string;
      subject?:      string;
    },
  ) {
    await this.get(scope, id); // 404 guard

    const updateData: any = {};
    if (data.subject      !== undefined) updateData.subject      = data.subject;
    if (data.priority     !== undefined) updateData.priority     = data.priority;
    if (data.assignedToId !== undefined) updateData.assignedToId = data.assignedToId;
    if (data.department   !== undefined) updateData.department   = data.department;
    if (data.slaDeadline  !== undefined) updateData.slaDeadline  = new Date(data.slaDeadline);

    if (data.status !== undefined) {
      updateData.status = data.status;
      if (data.status === 'RESOLVED') updateData.resolvedAt = new Date();
      if (data.status === 'CLOSED')   updateData.closedAt   = new Date();
    }

    return this.prisma.ticket.update({ where: { id }, data: updateData });
  }

  async remove(scope: TenantScope, id: string) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, tenantId: scope.tenantId, businessId: scope.businessId },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    await this.prisma.ticket.delete({ where: { id } });
    return { deleted: true };
  }
}
