import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

// ── Filter builder ─────────────────────────────────────────────────────────────

interface FilterRule {
  field:    string;
  operator: string;
  value:    unknown;
}

interface FilterSpec {
  rules?: FilterRule[];
}

function buildWhere(filters: unknown): Record<string, unknown> {
  const spec = filters as FilterSpec;
  if (!spec || !Array.isArray(spec.rules) || spec.rules.length === 0) return {};

  const andClauses: Record<string, unknown>[] = [];

  for (const rule of spec.rules) {
    switch (rule.field) {
      case 'source':
        andClauses.push({ source: { equals: rule.value as string, mode: 'insensitive' } });
        break;

      case 'optedOut':
        andClauses.push({ optedOut: Boolean(rule.value) });
        break;

      case 'isBlocked':
        andClauses.push({ isBlocked: Boolean(rule.value) });
        break;

      case 'tags': {
        const tagNames = Array.isArray(rule.value) ? (rule.value as string[]) : [rule.value as string];
        andClauses.push({
          tags: {
            some: {
              tag: {
                name: { in: tagNames },
              },
            },
          },
        });
        break;
      }

      default:
        // Unknown field — skip
        break;
    }
  }

  if (andClauses.length === 0) return {};
  return { AND: andClauses };
}

// ── Service ────────────────────────────────────────────────────────────────────

@Injectable()
export class SegmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    scope: TenantScope,
    query: { page?: number; limit?: number; search?: string },
  ) {
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const skip  = (page - 1) * limit;
    const where: any = { tenantId: scope.tenantId, businessId: scope.businessId };
    if (query.search) where.name = { contains: query.search, mode: 'insensitive' };

    const [segments, total] = await Promise.all([
      this.prisma.segment.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      this.prisma.segment.count({ where }),
    ]);
    return { segments, total, page, limit };
  }

  async create(scope: TenantScope, data: { name: string; description?: string; filters: unknown }) {
    return this.prisma.segment.create({
      data: {
        tenantId:    scope.tenantId,
        businessId:  scope.businessId,
        name:        data.name,
        description: data.description,
        filters:     data.filters as any,
        createdById: scope.userId,
      },
    });
  }

  async update(
    scope: TenantScope,
    id: string,
    data: { name?: string; description?: string; filters?: unknown },
  ) {
    await this.findOne(scope, id);
    return this.prisma.segment.update({
      where: { id },
      data:  {
        name:        data.name,
        description: data.description,
        filters:     data.filters as any,
      },
    });
  }

  async remove(scope: TenantScope, id: string) {
    await this.findOne(scope, id);
    await this.prisma.segment.delete({ where: { id } });
    return { deleted: true };
  }

  async preview(scope: TenantScope, filters: unknown) {
    const where = {
      businessId: scope.businessId,
      ...buildWhere(filters),
    };
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

    // Custom field keys via raw SQL (cross-DB compatible via Prisma $queryRaw)
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
    } catch { /* customFields may not exist yet */ }

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
