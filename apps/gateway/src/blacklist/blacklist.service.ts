import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

@Injectable()
export class BlacklistService {
  constructor(private readonly prisma: PrismaService) {}

  async list(scope: TenantScope, query: { page?: number; limit?: number; search?: string }) {
    const page   = Math.max(1, query.page ?? 1);
    const limit  = Math.min(100, query.limit ?? 20);
    const skip   = (page - 1) * limit;
    const search = (query.search ?? '').trim();
    const digits = search.replace(/\D/g, '');

    const where: any = {
      OR: [
        { tenantId: scope.tenantId },
        { tenantId: null },
      ],
      ...(search && {
        AND: {
          OR: [
            ...(digits ? [{ phone: { contains: digits } }] : []),
            { reason: { contains: search, mode: 'insensitive' } },
          ],
        },
      }),
    };

    const [entries, total, contactsByPhone] = await Promise.all([
      this.prisma.blacklistEntry.findMany({
        where,
        skip,
        take:    limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id:        true,
          phone:     true,
          reason:    true,
          createdAt: true,
          createdBy: { select: { id: true, name: true } },
        },
      }),
      this.prisma.blacklistEntry.count({ where }),
      // Resolve contact names for matched phones
      this.prisma.contact.findMany({
        where:  { tenantId: scope.tenantId },
        select: { phone: true, name: true },
      }).then(cs => new Map(cs.map(c => [c.phone, c.name]))),
    ]);

    return {
      success: true,
      data: entries.map(e => ({
        ...e,
        contactName: contactsByPhone.get(e.phone) ?? null,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      canManage: true,
    };
  }

  async create(scope: TenantScope, data: { phones: string[]; reason?: string; scope?: string }) {
    const added: string[] = [];
    const alreadyListed: string[] = [];

    for (const raw of data.phones) {
      const phone = raw.replace(/\D/g, '');
      if (!phone) continue;

      const existing = await this.prisma.blacklistEntry.findUnique({
        where: { tenantId_phone: { tenantId: scope.tenantId, phone } },
      });

      if (existing) {
        alreadyListed.push(phone);
      } else {
        await this.prisma.blacklistEntry.create({
          data: {
            tenantId:    scope.tenantId,
            phone,
            reason:      data.reason,
            createdById: scope.userId,
          },
        });
        added.push(phone);
      }
    }

    return { success: true, data: { added: added.length, alreadyListed: alreadyListed.length } };
  }

  async remove(scope: TenantScope, id: string) {
    const entry = await this.prisma.blacklistEntry.findUnique({ where: { id } });
    if (!entry) throw new NotFoundException('Blacklist entry not found');
    if (entry.tenantId !== scope.tenantId) {
      throw new ForbiddenException('Cannot delete platform-wide or foreign blacklist entry');
    }
    await this.prisma.blacklistEntry.delete({ where: { id } });
    return { success: true };
  }

  async history(scope: TenantScope, query: { phone?: string; limit?: number } = {}) {
    const limit = Math.min(200, query.limit ?? 100);
    const rows = await this.prisma.auditLog.findMany({
      where: {
        tenantId:   scope.tenantId,
        resource:   'blacklist',
        ...(query.phone && { resourceId: query.phone.replace(/\D/g, '') }),
      },
      select: {
        id:         true,
        action:     true,
        resourceId: true,
        metadata:   true,
        createdAt:  true,
        user:       { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take:    limit,
    });

    return {
      success: true,
      data: rows.map(r => {
        const meta = (r.metadata ?? {}) as { reason?: string; note?: string };
        return {
          id:     r.id,
          action: r.action === 'BLACKLIST_ADDED' ? 'added' : 'removed',
          phone:  r.resourceId,
          reason: meta.reason ?? null,
          note:   meta.note ?? null,
          by:     r.user,
          at:     r.createdAt,
        };
      }),
    };
  }
}
