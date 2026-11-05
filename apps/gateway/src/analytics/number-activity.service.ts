import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

export interface NumberActivityRow {
  phone: string;
  /** Contact name where we have one, so a row is a person rather than a number. */
  name: string | null;
  totalSent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  lastSentAt: Date | null;
  campaigns: number;
}

/**
 * How often each number has actually been messaged.
 *
 * Campaign reports answer "how did this send go"; this answers the question that comes
 * after it — "how much are we messaging this person" — which is the one that matters for
 * not burning a number's quality rating, and the one nobody could answer because the
 * figures only ever existed per campaign.
 *
 * Counted from the recipient rows rather than a tally kept as messages go out: a tally
 * drifts the moment a send is retried or a campaign is deleted, and this is the sort of
 * number someone will take an account-level decision on.
 */
@Injectable()
export class NumberActivityService {
  constructor(private readonly prisma: PrismaService) {}

  /** The tenants a reseller may report on: its own clients, and nobody else's. */
  private async clientTenantIds(resellerTenantId: string): Promise<string[]> {
    const clients = await this.prisma.tenant.findMany({
      where:  { parentId: resellerTenantId },
      select: { id: true },
    });
    return clients.map((c) => c.id);
  }

  /**
   * @param view Whose numbers to count. 'mine' is the signed-in department; 'clients' is
   *   every client beneath a reseller; 'platform' is everyone, for the super admin.
   */
  async list(
    scope: TenantScope,
    query: { page?: number; limit?: number; search?: string; view?: 'mine' | 'clients' | 'platform' } = {},
  ) {
    const page   = Math.max(1, query.page ?? 1);
    const limit  = Math.min(200, query.limit ?? 50);
    const offset = (page - 1) * limit;
    const view   = query.view ?? 'mine';

    // Scope is decided here from the caller's own role, never from the request.
    let tenantFilter: { ids: string[] } | 'all' | { businessId: string };
    if (view === 'platform') {
      if (scope.role !== 'SUPER_ADMIN') throw new ForbiddenException('Only the platform admin can see every account');
      tenantFilter = 'all';
    } else if (view === 'clients') {
      tenantFilter = { ids: await this.clientTenantIds(scope.tenantId) };
      if (!tenantFilter.ids.length) return { rows: [], total: 0, page, limit };
    } else {
      tenantFilter = { businessId: scope.businessId };
    }

    const where: string[] = [`cc."sentAt" IS NOT NULL`];
    const params: unknown[] = [];

    if (tenantFilter === 'all') {
      // no restriction
    } else if ('businessId' in tenantFilter) {
      params.push(tenantFilter.businessId);
      where.push(`c."businessId" = $${params.length}`);
    } else {
      params.push(tenantFilter.ids);
      where.push(`c."tenantId" = ANY($${params.length}::text[])`);
    }

    if (query.search?.trim()) {
      params.push(`%${query.search.trim()}%`);
      where.push(`cc.phone ILIKE $${params.length}`);
    }

    const whereSql = where.join(' AND ');

    // Grouped in SQL rather than in memory: a busy account has hundreds of thousands of
    // recipient rows, and the answer is a few hundred.
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT cc.phone                                                         AS phone,
              MAX(ct.name)                                                     AS name,
              COUNT(*)::int                                                    AS "totalSent",
              COUNT(*) FILTER (WHERE cc."deliveredAt" IS NOT NULL)::int        AS delivered,
              COUNT(*) FILTER (WHERE cc."readAt"      IS NOT NULL)::int        AS read,
              COUNT(*) FILTER (WHERE cc."repliedAt"   IS NOT NULL)::int        AS replied,
              COUNT(*) FILTER (WHERE cc.status = 'FAILED')::int                AS failed,
              MAX(cc."sentAt")                                                 AS "lastSentAt",
              COUNT(DISTINCT cc."campaignId")::int                             AS campaigns
         FROM campaign_contacts cc
         JOIN campaigns c  ON c.id = cc."campaignId"
         LEFT JOIN contacts ct ON ct.id = cc."contactId"
        WHERE ${whereSql}
        GROUP BY cc.phone
        ORDER BY COUNT(*) DESC, MAX(cc."sentAt") DESC
        LIMIT ${limit} OFFSET ${offset}`,
      ...params,
    );

    const totalRows = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count
         FROM (SELECT 1
                 FROM campaign_contacts cc
                 JOIN campaigns c ON c.id = cc."campaignId"
                WHERE ${whereSql}
                GROUP BY cc.phone) g`,
      ...params,
    );

    return {
      rows: rows as unknown as NumberActivityRow[],
      total: totalRows[0]?.count ?? 0,
      page,
      limit,
    };
  }
}
