import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

const COLORS = ['slate', 'blue', 'emerald', 'amber', 'rose', 'violet', 'sky', 'indigo', 'teal', 'orange'];

/**
 * Departments: the groups a conversation can be handed to.
 *
 * A department is a routing target, not a permission boundary. Being in Sales does not
 * change what someone can see — that is what their permissions decide — it decides which
 * handovers reach them.
 */
@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(scope: TenantScope) {
    const departments = await this.prisma.department.findMany({
      where:   { businessId: scope.businessId, tenantId: scope.tenantId },
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      include: {
        members: { include: { user: { select: { id: true, name: true, email: true, role: true, avatar: true } } } },
        _count:  { select: { handovers: true } },
      },
    });

    // The open load per department, which is what makes the list worth looking at.
    const waiting = await this.prisma.handoverRequest.groupBy({
      by:     ['departmentId'],
      where:  { businessId: scope.businessId, status: { in: ['PENDING', 'ASSIGNED'] } },
      _count: { _all: true },
    });
    const byDepartment = new Map(waiting.map((w) => [w.departmentId, w._count._all]));

    return departments.map((d) => ({
      ...d,
      members: d.members.map((m) => m.user),
      waitingCount: byDepartment.get(d.id) ?? 0,
    }));
  }

  async create(scope: TenantScope, body: { name?: string; description?: string; color?: string; isDefault?: boolean; memberIds?: string[] }) {
    const name = body.name?.trim();
    if (!name) throw new BadRequestException('Give the department a name');

    const clash = await this.prisma.department.findFirst({
      where: { businessId: scope.businessId, name: { equals: name, mode: 'insensitive' } },
    });
    if (clash) throw new BadRequestException(`There is already a department called "${name}"`);

    const count = await this.prisma.department.count({ where: { businessId: scope.businessId } });
    const memberIds = await this.validMembers(scope, body.memberIds ?? []);

    if (body.isDefault) await this.clearDefault(scope);

    return this.prisma.department.create({
      data: {
        tenantId:    scope.tenantId,
        businessId:  scope.businessId,
        name,
        description: body.description?.trim() || null,
        color:       COLORS.includes(body.color ?? '') ? body.color! : 'slate',
        order:       count,
        // The first department becomes the default, so routing has somewhere to land
        // without anybody having to think about it.
        isDefault:   body.isDefault ?? count === 0,
        members:     { create: memberIds.map((userId) => ({ userId })) },
      },
      include: { members: { include: { user: { select: { id: true, name: true, email: true } } } } },
    });
  }

  async update(
    scope: TenantScope, id: string,
    body: { name?: string; description?: string | null; color?: string; enabled?: boolean; isDefault?: boolean; order?: number; memberIds?: string[] },
  ) {
    await this.find(scope, id);

    if (body.name?.trim()) {
      const clash = await this.prisma.department.findFirst({
        where: { businessId: scope.businessId, name: { equals: body.name.trim(), mode: 'insensitive' }, id: { not: id } },
      });
      if (clash) throw new BadRequestException(`There is already a department called "${body.name.trim()}"`);
    }
    if (body.isDefault) await this.clearDefault(scope);

    if (body.memberIds) {
      const memberIds = await this.validMembers(scope, body.memberIds);
      await this.prisma.departmentMember.deleteMany({ where: { departmentId: id } });
      if (memberIds.length) {
        await this.prisma.departmentMember.createMany({
          data: memberIds.map((userId) => ({ departmentId: id, userId })),
        });
      }
    }

    return this.prisma.department.update({
      where: { id },
      data: {
        name:        body.name?.trim(),
        description: body.description === null ? null : body.description?.trim(),
        color:       body.color && COLORS.includes(body.color) ? body.color : undefined,
        enabled:     body.enabled,
        isDefault:   body.isDefault,
        order:       body.order,
      },
      include: { members: { include: { user: { select: { id: true, name: true, email: true } } } } },
    });
  }

  async remove(scope: TenantScope, id: string) {
    const department = await this.find(scope, id);

    const waiting = await this.prisma.handoverRequest.count({
      where: { departmentId: id, status: { in: ['PENDING', 'ASSIGNED'] } },
    });
    if (waiting > 0) {
      throw new BadRequestException(
        `${waiting} conversation${waiting === 1 ? '' : 's'} still waiting on this department. Deal with those first.`,
      );
    }

    await this.prisma.department.delete({ where: { id } });

    // The workspace should always have somewhere for a handover to land.
    if (department.isDefault) {
      const next = await this.prisma.department.findFirst({
        where:   { businessId: scope.businessId, enabled: true },
        orderBy: { order: 'asc' },
      });
      if (next) await this.prisma.department.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    return { deleted: true };
  }

  private async find(scope: TenantScope, id: string) {
    const department = await this.prisma.department.findFirst({
      where: { id, businessId: scope.businessId, tenantId: scope.tenantId },
    });
    if (!department) throw new NotFoundException('That department does not exist');
    return department;
  }

  private async clearDefault(scope: TenantScope): Promise<void> {
    await this.prisma.department.updateMany({
      where: { businessId: scope.businessId, isDefault: true },
      data:  { isDefault: false },
    });
  }

  /** Only active members of this workspace, so a department cannot hold a stranger. */
  private async validMembers(scope: TenantScope, ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const users = await this.prisma.user.findMany({
      where:  { id: { in: ids }, tenantId: scope.tenantId, isActive: true, removedAt: null },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }
}
