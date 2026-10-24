import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

// ── Rule types (mirrors lib/segmentRules.ts in the Next.js app) ───────────────

const TEXT_FIELDS = ['name', 'location', 'company', 'source', 'email'] as const;
type TextField = (typeof TEXT_FIELDS)[number];

type SegmentRule =
  | { field: TextField;       op: 'is' | 'contains';       values: string[] }
  | { field: 'tags';          op: 'any' | 'all' | 'none';  values: string[] }
  | { field: 'status';        op: 'is';                     values: ('active' | 'opted_out' | 'blacklisted')[] }
  | { field: 'leadStage';     op: 'any';                    values: string[] }
  | { field: 'custom'; key: string; op: 'is' | 'contains'; values: string[] };

interface SegmentFilters {
  rules: SegmentRule[];
}

// ── Validation ─────────────────────────────────────────────────────────────────

function validateFilters(raw: unknown): SegmentFilters {
  if (!raw || typeof raw !== 'object') throw new BadRequestException('filters must be an object');
  const f = raw as Record<string, unknown>;
  if (!Array.isArray(f.rules)) throw new BadRequestException('filters.rules must be an array');
  if (f.rules.length > 20) throw new BadRequestException('At most 20 rules allowed');

  for (const rule of f.rules) {
    if (!rule || typeof rule !== 'object') throw new BadRequestException('Each rule must be an object');
    const r = rule as Record<string, unknown>;
    if (typeof r.field !== 'string') throw new BadRequestException('Each rule must have a string field');
    if (!Array.isArray(r.values) || r.values.length === 0)
      throw new BadRequestException(`Rule "${r.field}" must have a non-empty values array`);
    if (r.field === 'custom' && typeof r.key !== 'string')
      throw new BadRequestException('Custom rules must have a key property');
  }

  return f as unknown as SegmentFilters;
}

// ── Where-clause builder (full port of lib/segments.ts) ───────────────────────

function textClause(field: TextField, op: 'is' | 'contains', values: string[]): Record<string, unknown> {
  return {
    OR: values.map((v) => ({
      [field]: op === 'is'
        ? { equals: v, mode: 'insensitive' }
        : { contains: v, mode: 'insensitive' },
    })),
  };
}

async function buildWhere(
  prisma: PrismaService,
  tenantId: string,
  businessId: string,
  rules: SegmentRule[],
): Promise<Record<string, unknown>> {
  if (!rules.length) return { tenantId, businessId, isBlocked: false };

  const and: Record<string, unknown>[] = [];
  let blacklisted: string[] | null = null;

  const getBlacklisted = async (): Promise<string[]> => {
    if (blacklisted) return blacklisted;
    const rows = await prisma.blacklistEntry.findMany({
      where: { OR: [{ tenantId }, { tenantId: null }] },
      select: { phone: true },
    });
    blacklisted = rows.map((r) => r.phone);
    return blacklisted;
  };

  for (const rule of rules) {
    switch (rule.field) {
      case 'name':
      case 'location':
      case 'company':
      case 'source':
      case 'email':
        and.push(textClause(rule.field, rule.op, rule.values));
        break;

      case 'tags':
        if (rule.op === 'any')
          and.push({ tags: { some: { tagId: { in: rule.values } } } });
        else if (rule.op === 'none')
          and.push({ tags: { none: { tagId: { in: rule.values } } } });
        else // 'all' — every tag must be present
          for (const tagId of rule.values)
            and.push({ tags: { some: { tagId } } });
        break;

      case 'leadStage':
        and.push({ leads: { some: { stageId: { in: rule.values } } } });
        break;

      case 'status': {
        const orClauses: Record<string, unknown>[] = [];
        for (const s of rule.values) {
          if (s === 'opted_out')   orClauses.push({ optedOut: true });
          if (s === 'active')      orClauses.push({ optedOut: false, phone: { notIn: await getBlacklisted() } });
          if (s === 'blacklisted') orClauses.push({ phone: { in: await getBlacklisted() } });
        }
        if (orClauses.length) and.push({ OR: orClauses });
        break;
      }

      case 'custom':
        and.push({
          OR: rule.values.map((v) => ({
            customFields: rule.op === 'is'
              ? { path: [rule.key], equals: v }
              : { path: [rule.key], string_contains: v },
          })),
        });
        break;
    }
  }

  return { tenantId, businessId, isBlocked: false, ...(and.length && { AND: and }) };
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
    if (!data.name?.trim()) throw new BadRequestException('name is required');
    const filters = validateFilters(data.filters);
    return this.prisma.segment.create({
      data: {
        tenantId:    scope.tenantId,
        businessId:  scope.businessId,
        name:        data.name.trim(),
        description: data.description,
        filters:     filters as any,
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
    const filters = data.filters !== undefined ? validateFilters(data.filters) : undefined;
    return this.prisma.segment.update({
      where: { id },
      data: {
        ...(data.name        !== undefined && { name: data.name.trim() }),
        ...(data.description !== undefined && { description: data.description }),
        ...(filters          !== undefined && { filters: filters as any }),
      },
    });
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
