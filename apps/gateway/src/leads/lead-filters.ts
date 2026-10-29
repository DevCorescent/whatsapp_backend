/**
 * The filters a lead list or export can be narrowed by, and the columns an export can
 * carry.
 *
 * Shared by the list endpoint and the export endpoint so that what somebody sees on
 * screen is exactly what downloads. Building the same `where` twice is how an export
 * quietly stops matching the list it came from.
 */

export interface LeadFilterQuery {
  search?: string;
  /** Comma-separated, so several can be combined from one query string. */
  stageId?: string;
  assignedToId?: string;
  scoreLabel?: string;
  qualifiedBy?: string;
  /** OPEN, WON or LOST, read from the stage's outcome. */
  outcome?: string;
  minScore?: string | number;
  maxScore?: string | number;
  minValue?: string | number;
  maxValue?: string | number;
  createdFrom?: string;
  createdTo?: string;
  qualifiedFrom?: string;
  qualifiedTo?: string;
  /** "1" to require, "0" to exclude. */
  aiQualified?: string;
  unassigned?: string;
  decisionMaker?: string;
  hasBudget?: string;
  hasTimeline?: string;
  closed?: string;
  /** Contact tag names, comma-separated. */
  tags?: string;
  minConfidence?: string | number;
  sort?: string;
}

const list = (v?: string): string[] =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const date = (v?: string): Date | undefined => {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/** "1"/"true"/"yes" is yes, "0"/"false"/"no" is no, anything else is "don't care". */
const tri = (v?: string): boolean | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).toLowerCase();
  if (['1', 'true', 'yes'].includes(s)) return true;
  if (['0', 'false', 'no'].includes(s)) return false;
  return undefined;
};

export const LEAD_SORTS: Record<string, Record<string, 'asc' | 'desc'>[]> = {
  newest:      [{ createdAt: 'desc' }],
  oldest:      [{ createdAt: 'asc' }],
  score_high:  [{ score: 'desc' }, { createdAt: 'desc' }],
  score_low:   [{ score: 'asc' }, { createdAt: 'desc' }],
  value_high:  [{ value: 'desc' }, { createdAt: 'desc' }],
  recent_ai:   [{ aiQualifiedAt: 'desc' }],
  updated:     [{ updatedAt: 'desc' }],
};

export function leadOrderBy(sort?: string) {
  return LEAD_SORTS[sort ?? 'newest'] ?? LEAD_SORTS.newest;
}

/** One Prisma `where` from a query string, used by both the list and the export. */
export function buildLeadWhere(
  scope: { tenantId: string; businessId: string },
  q: LeadFilterQuery,
): Record<string, any> {
  const where: Record<string, any> = { tenantId: scope.tenantId, businessId: scope.businessId };
  const and: Record<string, any>[] = [];

  const stages = list(q.stageId);
  if (stages.length) where.stageId = stages.length === 1 ? stages[0] : { in: stages };

  const agents = list(q.assignedToId);
  if (agents.length) where.assignedToId = agents.length === 1 ? agents[0] : { in: agents };

  const labels = list(q.scoreLabel);
  if (labels.length) where.scoreLabel = labels.length === 1 ? labels[0] : { in: labels };

  const sources = list(q.qualifiedBy);
  if (sources.length) where.qualifiedBy = sources.length === 1 ? sources[0] : { in: sources };

  if (q.outcome && q.outcome !== 'ALL') where.stage = { outcome: q.outcome };

  const minScore = num(q.minScore);
  const maxScore = num(q.maxScore);
  if (minScore !== undefined || maxScore !== undefined) {
    where.score = {
      ...(minScore !== undefined ? { gte: minScore } : {}),
      ...(maxScore !== undefined ? { lte: maxScore } : {}),
    };
  }

  const minValue = num(q.minValue);
  const maxValue = num(q.maxValue);
  if (minValue !== undefined || maxValue !== undefined) {
    where.value = {
      ...(minValue !== undefined ? { gte: minValue } : {}),
      ...(maxValue !== undefined ? { lte: maxValue } : {}),
    };
  }

  const createdFrom = date(q.createdFrom);
  const createdTo   = date(q.createdTo);
  if (createdFrom || createdTo) {
    where.createdAt = {
      ...(createdFrom ? { gte: createdFrom } : {}),
      // An end date means the end of that day, not midnight at the start of it.
      ...(createdTo ? { lte: endOfDay(createdTo) } : {}),
    };
  }

  const qualifiedFrom = date(q.qualifiedFrom);
  const qualifiedTo   = date(q.qualifiedTo);
  if (qualifiedFrom || qualifiedTo) {
    where.aiQualifiedAt = {
      ...(qualifiedFrom ? { gte: qualifiedFrom } : {}),
      ...(qualifiedTo ? { lte: endOfDay(qualifiedTo) } : {}),
    };
  }

  const aiQualified = tri(q.aiQualified);
  if (aiQualified === true)  and.push({ aiQualifiedAt: { not: null } });
  if (aiQualified === false) and.push({ aiQualifiedAt: null });

  const unassigned = tri(q.unassigned);
  if (unassigned === true)  where.assignedToId = null;
  if (unassigned === false) and.push({ assignedToId: { not: null } });

  const decisionMaker = tri(q.decisionMaker);
  if (decisionMaker !== undefined) where.isDecisionMaker = decisionMaker;

  const hasBudget = tri(q.hasBudget);
  if (hasBudget === true)  and.push({ budget: { not: null } });
  if (hasBudget === false) and.push({ budget: null });

  const hasTimeline = tri(q.hasTimeline);
  if (hasTimeline === true)  and.push({ timeline: { not: null } });
  if (hasTimeline === false) and.push({ timeline: null });

  const closed = tri(q.closed);
  if (closed === true)  and.push({ closedAt: { not: null } });
  if (closed === false) and.push({ closedAt: null });

  const minConfidence = num(q.minConfidence);
  if (minConfidence !== undefined) and.push({ aiConfidence: { gte: minConfidence } });

  const tags = list(q.tags);
  if (tags.length) {
    where.contact = {
      ...(where.contact ?? {}),
      tags: { some: { tag: { name: { in: tags } } } },
    };
  }

  if (q.search?.trim()) {
    const term = q.search.trim();
    and.push({
      OR: [
        { title:       { contains: term, mode: 'insensitive' } },
        { requirement: { contains: term, mode: 'insensitive' } },
        { aiSummary:   { contains: term, mode: 'insensitive' } },
        { contact: { name:  { contains: term, mode: 'insensitive' } } },
        { contact: { phone: { contains: term.replace(/\D/g, '') || term } } },
        { contact: { company: { contains: term, mode: 'insensitive' } } },
      ],
    });
  }

  if (and.length) where.AND = and;
  return where;
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

// ─── Export columns ───────────────────────────────────────────────────────────

export interface LeadRow {
  id: string;
  title: string;
  score: number;
  scoreLabel: string;
  value: number | null;
  currency: string;
  budget: string | null;
  authority: string | null;
  requirement: string | null;
  timeline: string | null;
  companySize: string | null;
  isDecisionMaker: boolean;
  notes: string | null;
  lostReason: string | null;
  closedAt: Date | null;
  qualifiedBy: string;
  aiQualifiedAt: Date | null;
  aiScore: number | null;
  aiConfidence: number | null;
  aiSummary: string | null;
  aiIntent: string | null;
  aiNextStep: string | null;
  aiModel: string | null;
  aiBreakdown: unknown;
  createdAt: Date;
  updatedAt: Date;
  contact: { name: string; phone: string; email: string | null; company: string | null; source: string | null; tags?: { tag: { name: string } }[] } | null;
  assignedTo: { name: string; email: string } | null;
  stage: { name: string; outcome: string } | null;
}

const when = (d: Date | null | undefined): string => (d ? d.toISOString().slice(0, 19).replace('T', ' ') : '');

/** Every column an export can hold, in the order they appear by default. */
export const LEAD_COLUMNS: { key: string; label: string; value: (l: LeadRow) => string | number }[] = [
  { key: 'title',        label: 'Lead',            value: (l) => l.title },
  { key: 'contactName',  label: 'Contact',         value: (l) => l.contact?.name ?? '' },
  { key: 'phone',        label: 'Phone',           value: (l) => (l.contact?.phone ? `+${l.contact.phone}` : '') },
  { key: 'email',        label: 'Email',           value: (l) => l.contact?.email ?? '' },
  { key: 'company',      label: 'Company',         value: (l) => l.contact?.company ?? '' },
  { key: 'stage',        label: 'Stage',           value: (l) => l.stage?.name ?? '' },
  { key: 'outcome',      label: 'Outcome',         value: (l) => l.stage?.outcome ?? '' },
  { key: 'score',        label: 'Score',           value: (l) => l.score },
  { key: 'scoreLabel',   label: 'Rating',          value: (l) => l.scoreLabel },
  { key: 'qualifiedBy',  label: 'Qualified by',    value: (l) => l.qualifiedBy },
  { key: 'aiConfidence', label: 'AI confidence',   value: (l) => l.aiConfidence ?? '' },
  { key: 'aiSummary',    label: 'AI summary',      value: (l) => l.aiSummary ?? '' },
  { key: 'aiIntent',     label: 'What they want',  value: (l) => l.aiIntent ?? '' },
  { key: 'aiNextStep',   label: 'Next step',       value: (l) => l.aiNextStep ?? '' },
  { key: 'budget',       label: 'Budget',          value: (l) => l.budget ?? '' },
  { key: 'authority',    label: 'Authority',       value: (l) => l.authority ?? '' },
  { key: 'requirement',  label: 'Requirement',     value: (l) => l.requirement ?? '' },
  { key: 'timeline',     label: 'Timeline',        value: (l) => l.timeline ?? '' },
  { key: 'companySize',  label: 'Company size',    value: (l) => l.companySize ?? '' },
  { key: 'decisionMaker', label: 'Decision maker', value: (l) => (l.isDecisionMaker ? 'yes' : 'no') },
  { key: 'value',        label: 'Deal value',      value: (l) => l.value ?? '' },
  { key: 'currency',     label: 'Currency',        value: (l) => l.currency },
  { key: 'assignedTo',   label: 'Owner',           value: (l) => l.assignedTo?.name ?? '' },
  { key: 'tags',         label: 'Tags',            value: (l) => (l.contact?.tags ?? []).map((t) => t.tag.name).join('; ') },
  { key: 'source',       label: 'Contact source',  value: (l) => l.contact?.source ?? '' },
  { key: 'notes',        label: 'Notes',           value: (l) => l.notes ?? '' },
  { key: 'lostReason',   label: 'Lost reason',     value: (l) => l.lostReason ?? '' },
  { key: 'createdAt',    label: 'Created',         value: (l) => when(l.createdAt) },
  { key: 'updatedAt',    label: 'Updated',         value: (l) => when(l.updatedAt) },
  { key: 'qualifiedAt',  label: 'Scored at',       value: (l) => when(l.aiQualifiedAt) },
  { key: 'closedAt',     label: 'Closed',          value: (l) => when(l.closedAt) },
  { key: 'aiModel',      label: 'Model',           value: (l) => l.aiModel ?? '' },
  {
    key: 'breakdown', label: 'Score breakdown',
    value: (l) => {
      const scores = (l.aiBreakdown as { scores?: Record<string, number> } | null)?.scores;
      return scores ? Object.entries(scores).map(([k, v]) => `${k}:${v}`).join(' ') : '';
    },
  },
];

/** The columns chosen by default — enough to be useful without being unreadable. */
export const DEFAULT_LEAD_COLUMNS = [
  'title', 'contactName', 'phone', 'company', 'stage', 'score', 'scoreLabel',
  'qualifiedBy', 'aiSummary', 'aiNextStep', 'budget', 'timeline', 'value', 'assignedTo', 'createdAt',
];

/** A CSV, with Excel's separator hint so it opens in columns on a comma locale. */
export function leadsToCsv(leads: LeadRow[], columnKeys: string[]): string {
  const chosen = columnKeys.length
    ? LEAD_COLUMNS.filter((c) => columnKeys.includes(c.key))
    : LEAD_COLUMNS.filter((c) => DEFAULT_LEAD_COLUMNS.includes(c.key));
  const columns = chosen.length ? chosen : LEAD_COLUMNS;

  const escape = (v: string | number): string => {
    const s = String(v ?? '');
    // A cell a spreadsheet would run as a formula gets an apostrophe, because exported
    // customer text must never execute. A phone number is the exception worth making:
    // "+919876543210" opens with a + but is plainly a number, and prefixing every
    // exported phone with an apostrophe would be its own bug.
    const looksLikeFormula = /^=/.test(s) || (/^[+\-@]/.test(s) && !/^[+\-]?[\d\s()\-+]+$/.test(s));
    const safe = looksLikeFormula ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };

  const header = columns.map((c) => escape(c.label)).join(',');
  const rows = leads.map((l) => columns.map((c) => escape(c.value(l))).join(','));
  return [header, ...rows].join('\r\n');
}
