/**
 * The parts with arithmetic or string handling in them, checked without a database:
 * the weighted score, the score bands, the lead filters, the CSV, the keyword matcher and
 * the JSON extraction that stands between a chatty model and a stored lead.
 */
import {
  CRITERIA, DEFAULT_WEIGHTS, scoreLabelFor,
} from './libs/common/src/leads/lead-qualification.service';
import { DEFAULT_REQUEST_KEYWORDS, matchesHumanRequest } from './libs/common/src/handover/handover.service';
import { extractJsonObject } from './libs/common/src/ai/llm.service';
import {
  buildLeadWhere, leadOrderBy, leadsToCsv, LEAD_COLUMNS, DEFAULT_LEAD_COLUMNS,
} from './apps/gateway/src/leads/lead-filters';

let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failed++;
  console.log(`  FAIL ${name} ${detail}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(name, a === e, `\n       want ${e}\n       got  ${a}`);
}

// The same arithmetic the service does, so the expectations here are checked against the
// shipped weights rather than numbers copied by hand.
function weightsFor(raw: Record<string, number> | null): Record<string, number> {
  const picked = CRITERIA.map((k) => {
    const v = raw?.[k];
    return typeof v === 'number' && v >= 0 ? v : DEFAULT_WEIGHTS[k];
  });
  const total = picked.reduce((a, b) => a + b, 0);
  if (total <= 0) return { ...DEFAULT_WEIGHTS };
  return CRITERIA.reduce((acc, k, i) => { acc[k] = (picked[i] / total) * 100; return acc; }, {} as Record<string, number>);
}
function weightedScore(scores: Record<string, number>, raw: Record<string, number> | null): number {
  const w = weightsFor(raw);
  return Math.round(CRITERIA.reduce((sum, k) => sum + ((scores[k] ?? 0) * w[k]) / 100, 0));
}

console.log('\nThe default weights');
eq('five criteria', CRITERIA, ['budget', 'authority', 'need', 'timeline', 'engagement']);
ok('they add up to 100', Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0) === 100);

console.log('\nThe weighted score');
{
  const perfect = { budget: 100, authority: 100, need: 100, timeline: 100, engagement: 100 };
  eq('all top marks is 100', weightedScore(perfect, null), 100);
  eq('all zeros is 0', weightedScore({ budget: 0, authority: 0, need: 0, timeline: 0, engagement: 0 }, null), 0);

  // Need is weighted 30, so a lead with nothing but a clear need scores exactly that.
  eq('only need scores its weight',
    weightedScore({ budget: 0, authority: 0, need: 100, timeline: 0, engagement: 0 }, null),
    DEFAULT_WEIGHTS.need);

  // A business that cares only about budget should see budget drive the score alone.
  eq('a single-criterion weighting follows that criterion',
    weightedScore({ budget: 80, authority: 0, need: 0, timeline: 0, engagement: 0 },
      { budget: 100, authority: 0, need: 0, timeline: 0, engagement: 0 }),
    80);

  // Weights that do not add to 100 are normalised, not rejected.
  eq('weights are normalised',
    weightedScore({ budget: 100, authority: 0, need: 100, timeline: 0, engagement: 0 },
      { budget: 10, authority: 0, need: 10, timeline: 0, engagement: 0 }),
    100);
  eq('doubling every weight changes nothing',
    weightedScore({ budget: 60, authority: 40, need: 80, timeline: 20, engagement: 50 },
      Object.fromEntries(CRITERIA.map((k) => [k, DEFAULT_WEIGHTS[k] * 2])) as any),
    weightedScore({ budget: 60, authority: 40, need: 80, timeline: 20, engagement: 50 }, null));

  ok('all-zero weights fall back rather than dividing by zero',
    weightedScore({ budget: 100, authority: 100, need: 100, timeline: 100, engagement: 100 },
      { budget: 0, authority: 0, need: 0, timeline: 0, engagement: 0 }) === 100);

  // A missing criterion in the model's reply must not be read as full marks.
  eq('a missing criterion counts as zero',
    weightedScore({ need: 100 } as any, null), DEFAULT_WEIGHTS.need);
}

console.log('\nThe score bands');
eq('100 is qualified',  scoreLabelFor(100), 'QUALIFIED');
eq('80 is qualified',   scoreLabelFor(80),  'QUALIFIED');
eq('79 is hot',         scoreLabelFor(79),  'HOT');
eq('65 is hot',         scoreLabelFor(65),  'HOT');
eq('64 is warm',        scoreLabelFor(64),  'WARM');
eq('40 is warm',        scoreLabelFor(40),  'WARM');
eq('39 is cold',        scoreLabelFor(39),  'COLD');
eq('0 is cold',         scoreLabelFor(0),   'COLD');
ok('every band is reachable',
  new Set([0, 45, 70, 90].map(scoreLabelFor)).size === 4);

console.log('\nAsking for a person');
{
  // The service's own matcher, not a copy of it.
  const asks = (msg: string, keywords = DEFAULT_REQUEST_KEYWORDS) => matchesHumanRequest(msg, keywords);

  ok('a plain request matches',            asks('can I talk to a human please') !== null);
  ok('asking for an agent matches',        asks('I want an agent') !== null);
  ok('asking for a person matches',        asks('is there a real person there?') !== null);
  ok('customer care matches',              asks('connect me to customer care') !== null);
  ok('a normal question does not match',   asks('what are your prices?') === null);
  ok('"humanity" is not a request',        asks('your humanity is appreciated') === null);
  ok('"management fees" is not a request', asks('what are the management fees') === null);
  ok('"agents" plural still matches',      asks('do you have agents in Delhi') !== null);
  ok('a business can set its own words',   asks('mujhe insaan se baat karni hai', ['insaan']) === 'insaan');
  ok('an empty message matches nothing',   asks('') === null);
  ok('regex characters in a keyword are literal',
    asks('price is 10$ (ten)', ['10$ (ten)']) === '10$ (ten)');
}

console.log('\nReading JSON out of a chatty model');
eq('a bare object',        extractJsonObject('{"a":1}'), '{"a":1}');
eq('inside a code fence',  extractJsonObject('```json\n{"a":1}\n```'), '{"a":1}');
eq('after some prose',     extractJsonObject('Sure! Here it is:\n{"a":1}\nHope that helps'), '{"a":1}');
eq('nested objects',       extractJsonObject('x {"a":{"b":2}} y'), '{"a":{"b":2}}');
eq('a brace inside a string', extractJsonObject('{"a":"}"}'), '{"a":"}"}');
eq('an escaped quote',     extractJsonObject('{"a":"say \\"hi\\""}'), '{"a":"say \\"hi\\""}');
eq('no object at all',     extractJsonObject('I cannot help with that'), null);
eq('an unbalanced object', extractJsonObject('{"a":1'), null);

console.log('\nLead filters');
const scope = { tenantId: 't1', businessId: 'b1' };
{
  const base = buildLeadWhere(scope, {});
  eq('always scoped to the workspace', { tenantId: base.tenantId, businessId: base.businessId }, scope);

  eq('one stage is matched directly', buildLeadWhere(scope, { stageId: 's1' }).stageId, 's1');
  eq('several stages become an in-list', buildLeadWhere(scope, { stageId: 's1,s2' }).stageId, { in: ['s1', 's2'] });
  eq('a score range', buildLeadWhere(scope, { minScore: '40', maxScore: '80' }).score, { gte: 40, lte: 80 });
  eq('a one-sided score range', buildLeadWhere(scope, { minScore: '40' }).score, { gte: 40 });
  ok('a non-numeric score is ignored', buildLeadWhere(scope, { minScore: 'abc' }).score === undefined);

  const aiOnly = buildLeadWhere(scope, { aiQualified: '1' });
  ok('scored by the AI', JSON.stringify(aiOnly.AND).includes('aiQualifiedAt'));
  const notAi = buildLeadWhere(scope, { aiQualified: '0' });
  eq('never scored by the AI', notAi.AND, [{ aiQualifiedAt: null }]);
  ok('an absent flag filters nothing', buildLeadWhere(scope, {}).AND === undefined);

  eq('unassigned', buildLeadWhere(scope, { unassigned: 'true' }).assignedToId, null);
  ok('assigned to anyone', JSON.stringify(buildLeadWhere(scope, { unassigned: 'false' }).AND).includes('not'));

  const dated = buildLeadWhere(scope, { createdFrom: '2026-01-01', createdTo: '2026-01-31' });
  const lastDay = dated.createdAt.lte as Date;
  // The boundary is the end of that day where the server runs, which is what someone
  // picking "to 31 January" means.
  ok('a date range runs to the end of the last day',
    lastDay.getHours() === 23 && lastDay.getMinutes() === 59 && lastDay.getDate() === 31,
    lastDay.toString());
  ok('a nonsense date is ignored', buildLeadWhere(scope, { createdFrom: 'not-a-date' }).createdAt === undefined);

  const searched = buildLeadWhere(scope, { search: 'acme' });
  const searchJson = JSON.stringify(searched.AND);
  ok('search covers the title',   searchJson.includes('title'));
  ok('search covers the contact', searchJson.includes('contact'));
  ok('search covers the summary', searchJson.includes('aiSummary'));

  eq('tags filter through the contact',
    buildLeadWhere(scope, { tags: 'vip,hot' }).contact,
    { tags: { some: { tag: { name: { in: ['vip', 'hot'] } } } } });

  eq('an unknown sort falls back to newest', leadOrderBy('nonsense'), leadOrderBy(undefined));
  eq('sorting by score', leadOrderBy('score_high'), [{ score: 'desc' }, { createdAt: 'desc' }]);
}

console.log('\nThe CSV');
{
  const lead: any = {
    id: 'l1', title: 'Bulk messaging for Acme', score: 72, scoreLabel: 'HOT',
    value: 50000, currency: 'INR', budget: 'around 50k', authority: 'owner',
    requirement: 'messaging for 5000 customers', timeline: 'next month',
    companySize: '20-50', isDecisionMaker: true, notes: null, lostReason: null,
    closedAt: null, qualifiedBy: 'AI',
    aiQualifiedAt: new Date('2026-10-30T10:00:00Z'), aiScore: 72, aiConfidence: 85,
    aiSummary: 'Wants bulk messaging, has budget', aiIntent: 'Pricing for growth plan',
    aiNextStep: 'Send pricing', aiModel: 'llama', aiBreakdown: { scores: { need: 90, budget: 60 } },
    createdAt: new Date('2026-10-29T09:00:00Z'), updatedAt: new Date('2026-10-30T10:00:00Z'),
    contact: { name: 'Aman', phone: '919876543210', email: 'a@acme.com', company: 'Acme', source: 'whatsapp', tags: [{ tag: { name: 'vip' } }] },
    assignedTo: { name: 'Priya', email: 'p@x.com' }, stage: { name: 'Qualified', outcome: 'OPEN' },
  };

  const csv = leadsToCsv([lead], ['title', 'phone', 'score', 'aiSummary', 'tags', 'breakdown']);
  const [header, row] = csv.split('\r\n');
  eq('only the chosen columns, in the declared order', header,
    '"Lead","Phone","Score","AI summary","Tags","Score breakdown"');
  ok('the phone keeps its plus', row.includes('"+919876543210"'), row);
  ok('the breakdown is readable', row.includes('need:90'), row);
  ok('tags are joined', row.includes('"vip"'), row);

  const defaulted = leadsToCsv([lead], []);
  eq('no choice means the default columns',
    defaulted.split('\r\n')[0].split(',').length, DEFAULT_LEAD_COLUMNS.length);

  // A cell beginning with = is a formula to a spreadsheet, and this is customer text.
  const risky = leadsToCsv([{ ...lead, title: '=HYPERLINK("http://evil","click")' }], ['title']);
  ok('a formula is defused', risky.includes(`"'=HYPERLINK`), risky);
  const plus = leadsToCsv([{ ...lead, title: '+SUM(A1:A2)' }], ['title']);
  ok('a plus-formula is defused', plus.includes(`"'+SUM`), plus);

  const quoted = leadsToCsv([{ ...lead, aiSummary: 'He said "yes", twice' }], ['aiSummary']);
  ok('quotes are doubled', quoted.includes('""yes""'), quoted);

  const commas = leadsToCsv([{ ...lead, title: 'Acme, Inc' }], ['title']);
  eq('a comma stays inside one cell', commas.split('\r\n')[1], '"Acme, Inc"');

  ok('every column renders without a contact',
    LEAD_COLUMNS.every((c) => {
      try { c.value({ ...lead, contact: null, assignedTo: null, stage: null }); return true; }
      catch { return false; }
    }));

  eq('an empty list still has a header', leadsToCsv([], ['title']), '"Lead"');
}

console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
