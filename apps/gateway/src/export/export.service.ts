import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope, csvCell, csvPhone } from '@lib/common';

/**
 * `phoneColumns` names the columns written as text rather than left to Excel, which
 * otherwise opens 919589708682 as 9.19589E+11 — in the one column an exported contact
 * list exists for. Quoting alone does not help: a quoted run of digits is still a
 * number to a spreadsheet.
 *
 * Every other cell goes through `csvCell`, which also makes a value starting with `=`
 * inert — exported customer text must never execute in whoever's spreadsheet opens it.
 */
function buildCsv(headers: string[], rows: unknown[][], phoneColumns: string[] = []): string {
  const isPhone = headers.map((h) => phoneColumns.includes(h));
  const lines: string[] = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(row.map((v, i) => (isPhone[i] ? csvPhone(v) : csvCell(v))).join(','));
  }
  return lines.join('\r\n');
}

@Injectable()
export class ExportService {
  constructor(private readonly prisma: PrismaService) {}

  /** The CSV, built from the same rows the printable view uses. */
  async exportCsv(scope: TenantScope, type: string): Promise<string> {
    const { headers, rows, phoneColumns } = await this.exportRows(scope, type);
    return buildCsv(headers, rows, phoneColumns);
  }

  /**
   * One set of rows, two ways out.
   *
   * The CSV and the printable view have to agree about what an export contains, so they
   * come from here rather than each assembling their own idea of it.
   */
  async exportRows(
    scope: TenantScope,
    type: string,
  ): Promise<{ title: string; headers: string[]; rows: unknown[][]; phoneColumns: string[] }> {
    const { tenantId, businessId } = scope;

    if (type === 'contacts') {
      const contacts = await this.prisma.contact.findMany({
        where:   { tenantId, businessId },
        orderBy: { createdAt: 'desc' },
        select: {
          id:        true,
          name:      true,
          phone:     true,
          email:     true,
          company:   true,
          source:    true,
          optedOut:  true,
          createdAt: true,
        },
      });

      const headers = ['id', 'name', 'phone', 'email', 'company', 'source', 'optedOut', 'createdAt'];
      const rows = contacts.map((c) => [
        c.id, c.name, c.phone, c.email, c.company, c.source,
        c.optedOut, c.createdAt.toISOString(),
      ]);
      return { title: 'Contacts', headers, rows, phoneColumns: ['phone'] };
    }

    if (type === 'campaigns') {
      const campaigns = await this.prisma.campaign.findMany({
        where:   { tenantId, businessId },
        orderBy: { createdAt: 'desc' },
        select: {
          id:          true,
          name:        true,
          status:      true,
          totalCount:  true,
          sentCount:   true,
          failedCount: true,
          createdAt:   true,
        },
      });

      const headers = ['id', 'name', 'status', 'totalCount', 'sentCount', 'failedCount', 'createdAt'];
      const rows = campaigns.map((c) => [
        c.id, c.name, c.status, c.totalCount, c.sentCount, c.failedCount,
        c.createdAt.toISOString(),
      ]);
      return { title: 'Campaigns', headers, rows, phoneColumns: [] };
    }

    if (type === 'leads') {
      const leads = await this.prisma.lead.findMany({
        where:   { tenantId, businessId },
        orderBy: { createdAt: 'desc' },
        select: {
          id:        true,
          title:     true,
          score:     true,
          value:     true,
          createdAt: true,
          contact:   { select: { name: true, phone: true } },
          stage:     { select: { name: true } },
        },
      });

      const headers = ['id', 'title', 'contactName', 'contactPhone', 'stageName', 'score', 'value', 'createdAt'];
      const rows = leads.map((l) => [
        l.id, l.title,
        l.contact?.name, l.contact?.phone,
        l.stage?.name,
        l.score, l.value,
        l.createdAt.toISOString(),
      ]);
      return { title: 'Leads', headers, rows, phoneColumns: ['contactPhone'] };
    }

    // The chatbot screen has had an "Export responses" button since these runs started
    // being recorded, and this method refused it — "must be contacts, campaigns, or
    // leads" — so the one export of what customers actually answered did not exist.
    if (type === 'ivr-responses') {
      const runs = await this.prisma.flowRun.findMany({
        where:   { tenantId, businessId },
        orderBy: { startedAt: 'desc' },
        take:    5000,
        select: {
          id: true, flowName: true, status: true, variables: true,
          lastNodeLabel: true, startedAt: true, endedAt: true,
          contact: { select: { name: true, phone: true } },
        },
      });

      const headers = ['id', 'flow', 'contactName', 'contactPhone', 'status', 'answers', 'lastStep', 'startedAt', 'endedAt'];
      const rows = runs.map((r) => [
        r.id, r.flowName, r.contact?.name, r.contact?.phone, r.status,
        // One cell, because the questions differ from flow to flow and a column per
        // variable would make a different spreadsheet for every chatbot.
        Object.entries((r.variables ?? {}) as Record<string, unknown>)
          .map(([k, v]) => `${k}: ${String(v ?? '')}`)
          .join(' | '),
        r.lastNodeLabel,
        r.startedAt.toISOString(),
        r.endedAt ? r.endedAt.toISOString() : '',
      ]);
      return { title: 'Chatbot responses', headers, rows, phoneColumns: ['contactPhone'] };
    }

    if (type === 'faq-interest') {
      const taps = await this.prisma.faqInteraction.findMany({
        where:   { tenantId, businessId },
        orderBy: { createdAt: 'desc' },
        take:    5000,
        select: {
          id: true, question: true, intent: true, points: true, createdAt: true,
          contact: { select: { name: true, phone: true } },
        },
      });

      const headers = ['id', 'contactName', 'contactPhone', 'question', 'intent', 'points', 'askedAt'];
      const rows = taps.map((t) => [
        t.id, t.contact?.name, t.contact?.phone, t.question, t.intent, t.points,
        t.createdAt.toISOString(),
      ]);
      return { title: 'FAQ interest', headers, rows, phoneColumns: ['contactPhone'] };
    }

    throw new BadRequestException(
      `Unknown export type: ${type}. Must be contacts, campaigns, leads, ivr-responses or faq-interest.`,
    );
  }
}
