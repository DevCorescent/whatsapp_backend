import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

function escapeCsv(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines: string[] = [headers.join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCsv).join(','));
  }
  return lines.join('\n');
}

@Injectable()
export class ExportService {
  constructor(private readonly prisma: PrismaService) {}

  async exportCsv(scope: TenantScope, type: string): Promise<string> {
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
      return buildCsv(headers, rows);
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
      return buildCsv(headers, rows);
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
      return buildCsv(headers, rows);
    }

    throw new BadRequestException(`Unknown export type: ${type}. Must be contacts, campaigns, or leads.`);
  }
}
