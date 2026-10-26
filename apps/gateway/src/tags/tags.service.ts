import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(scope: TenantScope) {
    const tags = await this.prisma.tag.findMany({
      where: { tenantId: scope.tenantId, businessId: scope.businessId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { contacts: true } } },
    });
    return { tags };
  }

  async create(scope: TenantScope, data: { name: string; color: string }) {
    const existing = await this.prisma.tag.findFirst({
      where: { tenantId: scope.tenantId, businessId: scope.businessId, name: data.name },
    });
    if (existing) throw new ConflictException('A tag with this name already exists');

    return this.prisma.tag.create({
      data: {
        name: data.name.trim(),
        color: data.color || '#6366f1',
        tenantId: scope.tenantId,
        businessId: scope.businessId,
      },
    });
  }

  async update(scope: TenantScope, id: string, data: { name?: string; color?: string }) {
    const tag = await this.prisma.tag.findFirst({
      where: { id, tenantId: scope.tenantId, businessId: scope.businessId },
    });
    if (!tag) throw new NotFoundException('Tag not found');
    return this.prisma.tag.update({ where: { id }, data });
  }

  async remove(scope: TenantScope, id: string) {
    const tag = await this.prisma.tag.findFirst({
      where: { id, tenantId: scope.tenantId, businessId: scope.businessId },
    });
    if (!tag) throw new NotFoundException('Tag not found');
    await this.prisma.tag.delete({ where: { id } });
    return { deleted: true };
  }
}
