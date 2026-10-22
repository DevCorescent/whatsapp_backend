import { Injectable } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

type SearchType = 'all' | 'contacts' | 'conversations' | 'campaigns' | 'leads';

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(scope: TenantScope, q: string, type: SearchType = 'all') {
    const biz = scope.businessId;
    const q_ci = { contains: q, mode: 'insensitive' as const };

    const [contacts, conversations, campaigns, leads] = await Promise.all([
      (type === 'all' || type === 'contacts')
        ? this.prisma.contact.findMany({
            where: {
              businessId: biz,
              OR: [{ name: q_ci }, { phone: q_ci }],
            },
            take:   5,
            select: { id: true, name: true, phone: true, email: true, createdAt: true },
          })
        : [],

      (type === 'all' || type === 'conversations')
        ? this.prisma.conversation.findMany({
            where: {
              businessId: biz,
              contact: { name: q_ci },
            },
            take:    5,
            include: { contact: { select: { id: true, name: true, phone: true } } },
          })
        : [],

      (type === 'all' || type === 'campaigns')
        ? this.prisma.campaign.findMany({
            where: { businessId: biz, name: q_ci },
            take:   5,
            select: { id: true, name: true, status: true, createdAt: true },
          })
        : [],

      (type === 'all' || type === 'leads')
        ? this.prisma.lead.findMany({
            where: {
              businessId: biz,
              OR: [
                { title: q_ci },
                { contact: { name: q_ci } },
              ],
            },
            take:    5,
            include: { contact: { select: { id: true, name: true, phone: true } } },
          })
        : [],
    ]);

    return { contacts, conversations, campaigns, leads };
  }
}
