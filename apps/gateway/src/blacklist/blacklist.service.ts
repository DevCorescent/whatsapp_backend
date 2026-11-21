import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope, withCountryCode } from '@lib/common';

@Injectable()
export class BlacklistService {
  constructor(private readonly prisma: PrismaService) {}

  async list(scope: TenantScope, query: { page?: number; limit?: number; search?: string }) {
    const page   = Math.max(1, query.page ?? 1);
    const limit  = Math.min(200, query.limit ?? 20);
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
          // So an entry WhatsApp added is not mistaken for one a colleague added.
          source:    true,
          errorCode: true,
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

  /**
   * Block some numbers, and say what happened to each one.
   *
   * Two things were wrong here. The counts came back as numbers while the screen expected
   * the numbers themselves — it calls `.join` on the invalid ones to put them back in the
   * box — so blocking anything threw "Cannot read properties of undefined" and the screen
   * reported a failure after a successful write. And the only normalising was stripping
   * non-digits, while the screen promises a country code is added: a number blocked as
   * 9865856989 never matched a contact stored as 919865856989, so the block was accepted,
   * listed, and never stopped a single message.
   *
   * A number that cannot be one is now returned rather than quietly skipped.
   */
  async create(scope: TenantScope, data: { phones: string[]; reason?: string; scope?: string }) {
    const added: string[] = [];
    const alreadyListed: string[] = [];
    const invalid: string[] = [];

    for (const raw of data.phones) {
      const phone = withCountryCode(raw);
      // E.164 allows 15 digits; below 8 nothing is dialable. Kept as typed so the screen
      // can put it back in the box for the person to correct.
      if (phone.length < 8 || phone.length > 15) {
        if (String(raw ?? '').trim()) invalid.push(String(raw).trim());
        continue;
      }

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

    return { success: true, data: { added, alreadyListed, invalid } };
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
    const limit = Math.min(200, query.limit ?? 20);
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
