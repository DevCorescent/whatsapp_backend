import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

import {
  buildWhere, validateFilters, type SegmentFilters, type SegmentRule,
} from '@lib/common';

// ── Service ────────────────────────────────────────────────────────────────────

@Injectable()
export class SegmentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A stored segment as the app reads it.
   *
   * The rules live inside the `filters` column, and a segment is a live query rather than
   * a fixed list, so how many contacts it matches is only known by running it. Both are
   * lifted out here so every endpoint returns the same shape.
   */
  private async toView(
    scope: TenantScope,
    segment: { id: string; name: string; description: string | null; filters: unknown; createdAt: Date; updatedAt: Date },
  ) {
    const filters = segment.filters as { rules?: unknown } | null;
    // A row written before validation, or edited by hand, may hold anything.
    const rules = (Array.isArray(filters?.rules) ? filters.rules : []) as SegmentRule[];
    const where = await buildWhere(this.prisma, scope.tenantId, scope.businessId, rules);

    return {
      id:          segment.id,
      name:        segment.name,
      description: segment.description,
      rules,
      count:       await this.prisma.contact.count({ where }),
      createdAt:   segment.createdAt,
      updatedAt:   segment.updatedAt,
    };
  }

  async list(
    scope: TenantScope,
    query: { page?: number; limit?: number; search?: string },
  ) {
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, query.limit ?? 20);
    const skip  = (page - 1) * limit;
    const where: any = { tenantId: scope.tenantId, businessId: scope.businessId };
    if (query.search) where.name = { contains: query.search, mode: 'insensitive' };

    const [rows, total] = await Promise.all([
      this.prisma.segment.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      this.prisma.segment.count({ where }),
    ]);
    const segments = await Promise.all(rows.map((row) => this.toView(scope, row)));
    return { segments, total, page, limit };
  }

  async create(scope: TenantScope, data: { name: string; description?: string; filters: unknown }) {
    if (!data.name?.trim()) throw new BadRequestException('name is required');
    const filters = validateFilters(data.filters);
    const created = await this.prisma.segment.create({
      data: {
        tenantId:    scope.tenantId,
        businessId:  scope.businessId,
        name:        data.name.trim(),
        description: data.description,
        filters:     filters as any,
        createdById: scope.userId,
      },
    });
    return this.toView(scope, created);
  }

  async update(
    scope: TenantScope,
    id: string,
    data: { name?: string; description?: string; filters?: unknown },
  ) {
    await this.findOne(scope, id);
    const filters = data.filters !== undefined ? validateFilters(data.filters) : undefined;
    const updated = await this.prisma.segment.update({
      where: { id },
      data: {
        ...(data.name        !== undefined && { name: data.name.trim() }),
        ...(data.description !== undefined && { description: data.description }),
        ...(filters          !== undefined && { filters: filters as any }),
      },
    });
    return this.toView(scope, updated);
  }

  async remove(scope: TenantScope, id: string) {
    await this.findOne(scope, id);
    await this.prisma.segment.delete({ where: { id } });
    return { deleted: true };
  }

  async preview(scope: TenantScope, rawFilters: unknown) {
    const { tenantId, businessId } = scope;
    let rules: SegmentRule[] = [];
    try {
      const f = validateFilters(rawFilters);
      rules = f.rules;
    } catch {
      // If filters are invalid, return empty preview rather than crashing
      return { count: 0, sample: [] };
    }

    const where = await buildWhere(this.prisma, tenantId, businessId, rules);
    const [count, contacts] = await Promise.all([
      this.prisma.contact.count({ where }),
      this.prisma.contact.findMany({
        where,
        take: 20,
        orderBy: { createdAt: 'desc' },
        include: { tags: { include: { tag: true } } },
      }),
    ]);
    return { count, sample: contacts };
  }

  async options(scope: TenantScope) {
    const { tenantId, businessId } = scope;
    const [locations, sources, tags, stages] = await Promise.all([
      this.prisma.contact.groupBy({
        by: ['location'],
        where: { tenantId, businessId, isBlocked: false, location: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { location: 'desc' } },
        take: 200,
      }),
      this.prisma.contact.groupBy({
        by: ['source'],
        where: { tenantId, businessId, isBlocked: false, source: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { source: 'desc' } },
        take: 100,
      }),
      this.prisma.tag.findMany({
        where:   { tenantId, businessId },
        select:  { id: true, name: true, color: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.pipelineStage.findMany({
        where:   { tenantId },
        select:  { id: true, name: true },
        orderBy: { order: 'asc' },
      }),
    ]);

    let customKeys: string[] = [];
    try {
      const rows = await this.prisma.$queryRaw<{ key: string }[]>`
        SELECT DISTINCT jsonb_object_keys("customFields"::jsonb) AS key
        FROM contacts
        WHERE "tenantId" = ${tenantId} AND "businessId" = ${businessId}
          AND "customFields" IS NOT NULL AND jsonb_typeof("customFields"::jsonb) = 'object'
        LIMIT 100
      `;
      customKeys = rows.map((r) => r.key);
    } catch { /* customFields column may not exist yet */ }

    return {
      locations: locations
        .map((l) => ({ value: l.location!, count: (l._count as any)._all }))
        .filter((l) => l.value?.trim()),
      sources: sources.map((s) => s.source!).filter(Boolean),
      tags,
      stages,
      customKeys,
    };
  }

  private async findOne(scope: TenantScope, id: string) {
    const segment = await this.prisma.segment.findFirst({
      where: { id, tenantId: scope.tenantId, businessId: scope.businessId },
    });
    if (!segment) throw new NotFoundException('Segment not found');
    return segment;
  }
}
