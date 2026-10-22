import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

@Injectable()
export class QuickRepliesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(scope: TenantScope, query: { search?: string }) {
    const where: any = {
      tenantId:   scope.tenantId,
      businessId: scope.businessId,
    };
    if (query.search) {
      where.OR = [
        { shortcode: { contains: query.search, mode: 'insensitive' } },
        { content:   { contains: query.search, mode: 'insensitive' } },
      ];
    }
    return this.prisma.quickReply.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(scope: TenantScope, data: { shortcode: string; content: string }) {
    const shortcode = data.shortcode.toLowerCase().trim().replace(/\s+/g, '');
    return this.prisma.quickReply.create({
      data: {
        tenantId:   scope.tenantId,
        businessId: scope.businessId,
        shortcode,
        content:    data.content,
      },
    });
  }

  async update(scope: TenantScope, id: string, data: { shortcode?: string; content?: string }) {
    await this.findOne(scope, id);
    const shortcode = data.shortcode !== undefined
      ? data.shortcode.toLowerCase().trim().replace(/\s+/g, '')
      : undefined;
    return this.prisma.quickReply.update({
      where: { id },
      data:  {
        shortcode,
        content: data.content,
      },
    });
  }

  async remove(scope: TenantScope, id: string) {
    await this.findOne(scope, id);
    await this.prisma.quickReply.delete({ where: { id } });
    return { deleted: true };
  }

  private async findOne(scope: TenantScope, id: string) {
    const reply = await this.prisma.quickReply.findFirst({
      where: { id, tenantId: scope.tenantId, businessId: scope.businessId },
    });
    if (!reply) throw new NotFoundException('Quick reply not found');
    return reply;
  }
}
