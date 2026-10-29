import {
  Injectable, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

export interface AuditLogQuery {
  page?: number;
  limit?: number;
  q?: string;
}

@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  private generateInviteCode(length = 8): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let code = '';
    for (let i = 0; i < length; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  // ── Category ───────────────────────────────────────────────────────────────

  async getCategory(scope: TenantScope) {
    const tenant = await this.prisma.tenant.findUnique({
      where:   { id: scope.tenantId },
      include: { category: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');
    return { categoryId: tenant.categoryId, category: tenant.category };
  }

  async setCategory(scope: TenantScope, categoryId: string) {
    const category = await this.prisma.businessCategory.findUnique({
      where: { id: categoryId },
    });
    if (!category) throw new NotFoundException('Category not found');
    if (!category.isActive) throw new BadRequestException('Category is not active');

    const tenant = await this.prisma.tenant.update({
      where:   { id: scope.tenantId },
      data:    { categoryId },
      include: { category: true },
    });
    return { categoryId: tenant.categoryId, category: tenant.category };
  }

  // ── Invite code ────────────────────────────────────────────────────────────

  // ── Audit log ──────────────────────────────────────────────────────────────

  async listAuditLogs(scope: TenantScope, q: AuditLogQuery) {
    const page  = Math.max(1, q.page ?? 1);
    const limit = Math.min(100, q.limit ?? 20);
    const skip  = (page - 1) * limit;
    const where: Record<string, unknown> = { tenantId: scope.tenantId };
    if (q.q) {
      where.OR = [
        { action:   { contains: q.q, mode: 'insensitive' } },
        { resource: { contains: q.q, mode: 'insensitive' } },
        { user: { name: { contains: q.q, mode: 'insensitive' } } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    const logs = rows.map((r) => ({
      id:         r.id,
      action:     r.action,
      actor:      r.user?.name ?? r.user?.email ?? null,
      actorRole:  null as string | null,
      details:    [r.resource, r.resourceId].filter(Boolean).join(' · ') || null,
      ip:         null as string | null,
      createdAt:  r.createdAt,
    }));
    return { logs, total, page, limit };
  }

  async getInviteCode(scope: TenantScope) {
    const user = await this.prisma.user.findUnique({
      where:  { id: scope.userId },
      select: { id: true, inviteCode: true },
    });
    if (!user) throw new NotFoundException('User not found');

    if (user.inviteCode) {
      return { inviteCode: user.inviteCode };
    }

    const inviteCode = this.generateInviteCode();
    await this.prisma.user.update({
      where: { id: scope.userId },
      data:  { inviteCode },
    });
    return { inviteCode };
  }
}
