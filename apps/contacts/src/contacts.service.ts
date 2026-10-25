import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  // ── List ───────────────────────────────────────────────────────────────────

  async findAll(scope: TenantScope, query: {
    page?: number; limit?: number; search?: string;
    source?: string; tag?: string; optedOut?: boolean;
  }) {
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 50);
    const skip  = (page - 1) * limit;

    const where: any = { tenantId: scope.tenantId, businessId: scope.businessId };
    if (query.search) {
      where.OR = [
        { name:  { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.source)           where.source   = query.source;
    if (query.optedOut != null) where.optedOut  = query.optedOut;
    if (query.tag) {
      where.tags = { some: { tag: { name: { equals: query.tag, mode: 'insensitive' } } } };
    }

    const [contacts, total] = await Promise.all([
      this.prisma.contact.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
        include: { tags: { include: { tag: true } } },
      }),
      this.prisma.contact.count({ where }),
    ]);

    return { contacts, total, page, limit };
  }

  // ── Get one ────────────────────────────────────────────────────────────────

  async findOne(scope: TenantScope, id: string) {
    const contact = await this.prisma.contact.findFirst({
      where:   { id, tenantId: scope.tenantId, businessId: scope.businessId },
      include: { tags: { include: { tag: true } } },
    });
    if (!contact) throw new NotFoundException('Contact not found');
    return contact;
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  async create(scope: TenantScope, data: {
    name: string; phone: string; email?: string; company?: string;
    designation?: string; location?: string; source?: string;
    notes?: string; customFields?: Record<string, unknown>; tags?: string[];
  }) {
    const existing = await this.prisma.contact.findUnique({
      where: { phone_businessId: { phone: data.phone, businessId: scope.businessId } },
    });
    if (existing) throw new ConflictException('A contact with this phone number already exists');

    const { tags, ...rest } = data;
    const contact = await this.prisma.contact.create({
      data: {
        name:         rest.name,
        phone:        rest.phone,
        email:        rest.email,
        company:      rest.company,
        designation:  rest.designation,
        location:     rest.location,
        source:       rest.source,
        notes:        rest.notes,
        customFields: rest.customFields as any,
        tenantId:     scope.tenantId,
        businessId:   scope.businessId,
      },
      include: { tags: { include: { tag: true } } },
    });

    if (tags?.length) await this.syncTags(scope, contact.id, tags);
    return this.findOne(scope, contact.id);
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  async update(scope: TenantScope, id: string, data: {
    name?: string; phone?: string; email?: string; company?: string;
    designation?: string; location?: string; source?: string;
    notes?: string; customFields?: Record<string, unknown>;
    isBlocked?: boolean; optedOut?: boolean; tags?: string[];
  }) {
    await this.findOne(scope, id); // 404 guard

    const { tags, ...rest } = data;
    await this.prisma.contact.update({
      where: { id },
      data:  {
        name:         rest.name,
        phone:        rest.phone,
        email:        rest.email,
        company:      rest.company,
        designation:  rest.designation,
        location:     rest.location,
        source:       rest.source,
        notes:        rest.notes,
        customFields: rest.customFields as any,
        isBlocked:    rest.isBlocked,
        optedOut:     rest.optedOut,
      },
    });
    if (tags !== undefined) await this.syncTags(scope, id, tags);
    return this.findOne(scope, id);
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async remove(scope: TenantScope, id: string) {
    await this.findOne(scope, id); // 404 guard
    await this.prisma.contact.delete({ where: { id } });
    return { deleted: true };
  }

  // ── Bulk create ────────────────────────────────────────────────────────────

  async bulkCreate(scope: TenantScope, contacts: Array<{
    name: string; phone: string; email?: string; company?: string; source?: string;
  }>) {
    let created = 0, skipped = 0;

    for (const item of contacts) {
      try {
        await this.prisma.contact.upsert({
          where:  { phone_businessId: { phone: item.phone, businessId: scope.businessId } },
          create: { ...item, tenantId: scope.tenantId, businessId: scope.businessId },
          update: {},
        });
        created++;
      } catch {
        skipped++;
      }
    }

    return { created, skipped, total: contacts.length };
  }

  // ── Bulk action ────────────────────────────────────────────────────────────

  async bulkAction(
    scope: TenantScope,
    action: 'create' | 'delete' | 'block' | 'unblock' | 'addTag' | 'removeTag',
    ids?: string[],
    contacts?: Array<{ name: string; phone: string; email?: string; company?: string; source?: string }>,
    tagId?: string,
  ) {
    switch (action) {
      case 'create':
        return this.bulkCreate(scope, contacts ?? []);

      case 'delete': {
        const result = await this.prisma.contact.deleteMany({
          where: { id: { in: ids ?? [] }, businessId: scope.businessId },
        });
        return { affected: result.count };
      }

      case 'block': {
        const result = await this.prisma.contact.updateMany({
          where: { id: { in: ids ?? [] }, businessId: scope.businessId },
          data:  { isBlocked: true },
        });
        return { affected: result.count };
      }

      case 'unblock': {
        const result = await this.prisma.contact.updateMany({
          where: { id: { in: ids ?? [] }, businessId: scope.businessId },
          data:  { isBlocked: false },
        });
        return { affected: result.count };
      }

      case 'addTag': {
        const result = await this.prisma.contactTag.createMany({
          data:           (ids ?? []).map(contactId => ({ contactId, tagId: tagId! })),
          skipDuplicates: true,
        });
        return { affected: result.count };
      }

      case 'removeTag': {
        const result = await this.prisma.contactTag.deleteMany({
          where: { contactId: { in: ids ?? [] }, tagId },
        });
        return { affected: result.count };
      }

      default:
        throw new BadRequestException(`Unknown bulk action: ${action}`);
    }
  }

  // ── Import (CSV rows already parsed by caller) ────────────────────────────

  async importContacts(
    scope: TenantScope,
    rows: Array<Record<string, string>>,
    importTags: string[] = [],
  ) {
    let created = 0, skipped = 0;

    const mapped = rows.map(row => {
      const phone = row['phone'] ?? row['Phone'] ?? row['mobile'] ?? row['Mobile'] ?? '';
      const name  = row['name']  ?? row['Name']  ?? '';
      if (!name || !phone) return null;

      // Per-row tags column (comma-separated, e.g. "VIP,Hospital,Delhi")
      const rowTagsRaw = row['tags'] ?? row['Tags'] ?? row['tag'] ?? row['Tag'] ?? '';
      const rowTags = rowTagsRaw
        ? rowTagsRaw.split(',').map((t: string) => t.trim()).filter(Boolean)
        : [];

      return {
        name, phone,
        email:   row['email']   ?? row['Email']   ?? undefined,
        company: row['company'] ?? row['Company'] ?? undefined,
        source:  'import',
        tags:    [...new Set([...rowTags, ...importTags])],
      };
    }).filter((r): r is NonNullable<typeof r> => r !== null);

    for (const item of mapped) {
      try {
        const contact = await this.prisma.contact.upsert({
          where:  { phone_businessId: { phone: item.phone, businessId: scope.businessId } },
          create: { name: item.name, phone: item.phone, email: item.email, company: item.company, source: item.source, tenantId: scope.tenantId, businessId: scope.businessId },
          update: {},
        });
        if (item.tags.length) {
          await this.syncTagsAdd(scope, contact.id, item.tags);
        }
        created++;
      } catch {
        skipped++;
      }
    }

    return { created, skipped, total: mapped.length };
  }

  async importContactsV2(
    scope: TenantScope,
    contacts: Array<{
      name?: string; phone: string; email?: string; company?: string;
      designation?: string; location?: string; source?: string; notes?: string;
      tags?: string[];
    }>,
    importTags: string[] = [],
    dryRun = false,
  ) {
    const valid = contacts.filter(c => c.phone?.trim());
    if (dryRun) {
      return {
        total:   valid.length,
        created: valid.length,
        skipped: contacts.length - valid.length,
        sample:  valid.slice(0, 3).map(c => ({ name: c.name, phone: c.phone })),
      };
    }

    let created = 0, updated = 0, skipped = 0, failed = 0;
    const errors: { ref?: string; reason: string }[] = [];
    for (const item of valid) {
      try {
        const allTags = [...new Set([...(item.tags ?? []), ...importTags])];
        const existing = await this.prisma.contact.findUnique({
          where: { phone_businessId: { phone: item.phone, businessId: scope.businessId } },
          select: { id: true },
        });
        const contact = await this.prisma.contact.upsert({
          where:  { phone_businessId: { phone: item.phone, businessId: scope.businessId } },
          create: {
            name:        item.name ?? item.phone,
            phone:       item.phone,
            email:       item.email,
            company:     item.company,
            designation: item.designation,
            location:    item.location,
            source:      item.source ?? 'import',
            notes:       item.notes,
            tenantId:    scope.tenantId,
            businessId:  scope.businessId,
          },
          update: {
            ...(item.name  && { name: item.name }),
            ...(item.email && { email: item.email }),
          },
        });
        if (allTags.length) await this.syncTagsAdd(scope, contact.id, allTags);
        if (existing) updated++; else created++;
      } catch (err: any) {
        failed++;
        errors.push({ ref: item.phone, reason: String(err.message).slice(0, 200) });
      }
    }
    return { total: valid.length, created, updated, skipped, failed, errors };
  }

  // ── Sources ────────────────────────────────────────────────────────────────

  async getSources(scope: TenantScope) {
    const rows = await this.prisma.contact.groupBy({
      by:     ['source'],
      where:  { tenantId: scope.tenantId, businessId: scope.businessId, source: { not: null } },
      _count: { source: true },
      orderBy: { _count: { source: 'desc' } },
    });
    return rows.map(r => r.source).filter(Boolean);
  }

  // ── Tags ───────────────────────────────────────────────────────────────────

  async listTags(scope: TenantScope) {
    return this.prisma.tag.findMany({
      where:   { tenantId: scope.tenantId, businessId: scope.businessId },
      orderBy: { name: 'asc' },
    });
  }

  async createTag(scope: TenantScope, name: string, color?: string) {
    return this.prisma.tag.upsert({
      where:  { name_businessId: { name, businessId: scope.businessId } },
      create: { tenantId: scope.tenantId, businessId: scope.businessId, name, color: color ?? '#6366f1' },
      update: color ? { color } : {},
    });
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /** Add tags without removing existing ones — used during import. */
  private async syncTagsAdd(scope: TenantScope, contactId: string, tagNames: string[]) {
    for (const name of tagNames) {
      const tag = await this.prisma.tag.upsert({
        where:  { name_businessId: { name, businessId: scope.businessId } },
        create: { name, tenantId: scope.tenantId, businessId: scope.businessId },
        update: {},
      });
      await this.prisma.contactTag.upsert({
        where:  { contactId_tagId: { contactId, tagId: tag.id } },
        create: { contactId, tagId: tag.id },
        update: {},
      });
    }
  }

  private async syncTags(scope: TenantScope, contactId: string, tagNames: string[]) {
    // Remove all existing tags for this contact
    await this.prisma.contactTag.deleteMany({ where: { contactId } });
    if (!tagNames.length) return;

    // Upsert each tag name, then create the join row
    for (const name of tagNames) {
      const tag = await this.prisma.tag.upsert({
        where:  { name_businessId: { name, businessId: scope.businessId } },
        create: { name, tenantId: scope.tenantId, businessId: scope.businessId },
        update: {},
      });
      // ContactTag PK is (contactId, tagId) — upsert is a no-op if it already exists
      await this.prisma.contactTag.upsert({
        where:  { contactId_tagId: { contactId, tagId: tag.id } },
        create: { contactId, tagId: tag.id },
        update: {},
      });
    }
  }
}
