import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';

/**
 * What a segment means, in one place.
 *
 * This lived inside the gateway's segments service, so the campaign sender — in a
 * different app — could not reach it. Its comment said as much and then fell back to
 * "every contact in the business": choosing a segment of fifty VIPs sent the campaign to
 * the entire contact list, at a cost per message, with the segment's name on it.
 *
 * A segment is a saved rule, so it has to be evaluated wherever it is used, and there
 * must be exactly one evaluator or the preview and the send will disagree.
 */

// ── Rule types (mirrors lib/segmentRules.ts in the Next.js app) ───────────────

const TEXT_FIELDS = ['name', 'location', 'company', 'source', 'email'] as const;
type TextField = (typeof TEXT_FIELDS)[number];

type TextOp = 'is' | 'contains' | 'is_not' | 'starts_with' | 'ends_with' | 'is_empty' | 'not_empty';
const EMPTY_VALUE_OPS: TextOp[] = ['is_empty', 'not_empty'];

export type SegmentRule =
  | { field: TextField;       op: TextOp;                   values: string[] }
  | { field: 'tags';          op: 'any' | 'all' | 'none';  values: string[] }
  | { field: 'status';        op: 'is';                     values: ('active' | 'opted_out' | 'blacklisted')[] }
  | { field: 'leadStage';     op: 'any';                    values: string[] }
  | { field: 'custom'; key: string; op: 'is' | 'contains' | 'is_not' | 'starts_with'; values: string[] };

export interface SegmentFilters {
  rules: SegmentRule[];
}

// ── Validation ─────────────────────────────────────────────────────────────────

export function validateFilters(raw: unknown): SegmentFilters {
  if (!raw || typeof raw !== 'object') throw new BadRequestException('filters must be an object');
  const f = raw as Record<string, unknown>;
  if (!Array.isArray(f.rules)) throw new BadRequestException('filters.rules must be an array');
  if (f.rules.length > 20) throw new BadRequestException('At most 20 rules allowed');

  for (const rule of f.rules) {
    if (!rule || typeof rule !== 'object') throw new BadRequestException('Each rule must be an object');
    const r = rule as Record<string, unknown>;
    if (typeof r.field !== 'string') throw new BadRequestException('Each rule must have a string field');
    const isEmptyValueOp = typeof r.op === 'string' && EMPTY_VALUE_OPS.includes(r.op as TextOp);
    if (!Array.isArray(r.values) || (!isEmptyValueOp && r.values.length === 0))
      throw new BadRequestException(`Rule "${r.field}" must have a non-empty values array`);
    if (r.field === 'custom' && typeof r.key !== 'string')
      throw new BadRequestException('Custom rules must have a key property');
  }

  return f as unknown as SegmentFilters;
}

// ── Where-clause builder (full port of lib/segments.ts) ───────────────────────

function textClause(field: TextField, op: TextOp, values: string[]): Record<string, unknown> {
  if (op === 'is_empty')
    return { OR: [{ [field]: null }, { [field]: '' }] };
  if (op === 'not_empty')
    return { AND: [{ NOT: { [field]: null } }, { NOT: { [field]: '' } }] };
  return {
    OR: values.map((v) => ({
      [field]:
        op === 'is'          ? { equals: v, mode: 'insensitive' }
        : op === 'is_not'    ? { not: { equals: v, mode: 'insensitive' } }
        : op === 'starts_with' ? { startsWith: v, mode: 'insensitive' }
        : op === 'ends_with' ? { endsWith: v, mode: 'insensitive' }
        :                      { contains: v, mode: 'insensitive' },
    })),
  };
}

export async function buildWhere(
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
            customFields:
              rule.op === 'is'          ? { path: [rule.key], equals: v }
              : rule.op === 'is_not'    ? { NOT: { path: [rule.key], equals: v } }
              : rule.op === 'starts_with' ? { path: [rule.key], string_starts_with: v }
              :                           { path: [rule.key], string_contains: v },
          })),
        });
        break;
    }
  }

  return { tenantId, businessId, isBlocked: false, ...(and.length && { AND: and }) };
}
