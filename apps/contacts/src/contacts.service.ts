import { Injectable, Logger, NotFoundException, ConflictException, BadRequestException, Optional } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope, normalizePhone } from '@lib/common';
import { InboundPipelineService } from '../../../apps/messaging/src/webhook/inbound-pipeline.service';

@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly flowPipeline?: InboundPipelineService,
  ) {}

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
      // Phones are stored as bare digits, so a search typed as "+91 98765" has to be
      // reduced to digits or it matches nothing. Falls back to the raw term when there
      // are none, which is the case for a name or an email.
      const digits = normalizePhone(query.search);
      where.OR = [
        { name:  { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: digits || query.search } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.source)           where.source   = query.source;
    if (query.optedOut != null) where.optedOut  = query.optedOut;
    if (query.tag) {
      where.tags = { some: { tag: { name: { equals: query.tag, mode: 'insensitive' } } } };
    }

    const [contacts, total] = await this.prisma.withRetry(() => Promise.all([
      this.prisma.contact.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
        include: { tags: { include: { tag: true } } },
      }),
      this.prisma.contact.count({ where }),
    ]), 'contacts list');

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
    const phone = this.cleanPhone(data.phone);
    const existing = await this.prisma.contact.findUnique({
      where: { phone_businessId: { phone, businessId: scope.businessId } },
    });
    if (existing) throw new ConflictException('A contact with this phone number already exists');

    const { tags, ...rest } = { ...data, phone };
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
    this.dispatchContactCreated(scope, contact);
    return this.findOne(scope, contact.id);
  }

  /**
   * Phones are stored as bare digits, so the dashboard's `+91…` and a webhook's `91…` are
   * the same contact rather than two. Rejecting here beats silently storing something
   * undialable, since a campaign would then fail per-message with Meta's own error.
   */
  private cleanPhone(raw: string): string {
    const phone = normalizePhone(raw);
    if (phone.length < 8 || phone.length > 15) {
      throw new BadRequestException(
        'Enter a phone number with its country code, like 919876543210.',
      );
    }
    return phone;
  }

  private dispatchContactCreated(
    scope: TenantScope,
    contact: { id: string; name: string; phone: string },
  ) {
    if (!this.flowPipeline) return;
    void this.flowPipeline.triggerFlowForEvent({
      tenantId: scope.tenantId,
      businessId: scope.businessId,
      contactId: contact.id,
      trigger: 'CONTACT_CREATED',
      variables: { contactName: contact.name, contactPhone: contact.phone },
    }).catch((err) => this.logger.warn(`Could not trigger contact-created flow for ${contact.id}: ${(err as Error).message}`));
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  async update(scope: TenantScope, id: string, data: {
    name?: string; phone?: string; email?: string; company?: string;
    designation?: string; location?: string; source?: string;
    notes?: string; customFields?: Record<string, unknown>;
    isBlocked?: boolean; optedOut?: boolean; tags?: string[];
  }) {
    await this.findOne(scope, id); // 404 guard

    const { tags, ...rest } = data.phone === undefined
      ? data
      : { ...data, phone: this.cleanPhone(data.phone) };
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

    for (const raw of contacts) {
      try {
        const item = { ...raw, phone: this.cleanPhone(raw.phone) };
        const existing = await this.prisma.contact.findUnique({
          where: { phone_businessId: { phone: item.phone, businessId: scope.businessId } },
          select: { id: true },
        });
        const contact = await this.prisma.contact.upsert({
          where:  { phone_businessId: { phone: item.phone, businessId: scope.businessId } },
          create: { ...item, tenantId: scope.tenantId, businessId: scope.businessId },
          update: {},
        });
        if (!existing) this.dispatchContactCreated(scope, contact);
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
      const raw   = row['phone'] ?? row['Phone'] ?? row['mobile'] ?? row['Mobile'] ?? '';
      const name  = row['name']  ?? row['Name']  ?? '';
      // A spreadsheet writes a number however the person typed it — "+91 98765 43210",
      // "091…", with a dash. Any of those must land on the same row as the contact the
      // webhook already created, which means digits only.
      const phone = normalizePhone(raw);
      if (!name || phone.length < 8) return null;

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
        const existing = await this.prisma.contact.findUnique({
          where: { phone_businessId: { phone: item.phone, businessId: scope.businessId } },
          select: { id: true },
        });
        const contact = await this.prisma.contact.upsert({
          where:  { phone_businessId: { phone: item.phone, businessId: scope.businessId } },
          create: { name: item.name, phone: item.phone, email: item.email, company: item.company, source: item.source, tenantId: scope.tenantId, businessId: scope.businessId },
          update: {},
        });
        if (!existing) this.dispatchContactCreated(scope, contact);
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
      tags?: string[]; customFields?: Record<string, string>;
    }>,
    importTags: string[] = [],
    dryRun = false,
    opts: { mode?: 'skip' | 'update'; importId?: string; fileName?: string; sheetName?: string } = {},
  ) {
    const mode  = opts.mode === 'update' ? 'update' : 'skip';
    // Normalised before the existing-row lookup, so an imported "+91 98765 43210" matches
    // the contact the webhook created as "919876543210" instead of inserting a second one.
    const valid = contacts
      .map(c => ({ ...c, phone: normalizePhone(c.phone) }))
      .filter(c => c.phone.length >= 8);

    const existingRows = valid.length
      ? await this.prisma.contact.findMany({
          where:  { businessId: scope.businessId, phone: { in: valid.map(c => c.phone) } },
          select: { id: true, phone: true, customFields: true },
        })
      : [];
    const existingByPhone = new Map(existingRows.map(r => [r.phone, r]));

    if (dryRun) {
      const existingCount = valid.filter(c => existingByPhone.has(c.phone)).length;
      return {
        total:         valid.length,
        newCount:      valid.length - existingCount,
        existingCount,
        sample:        valid.slice(0, 3).map(c => ({ name: c.name, phone: c.phone })),
      };
    }

    let created = 0, updated = 0, skipped = 0, failed = 0;
    const errors: { ref?: string; reason: string }[] = [];
    for (const item of valid) {
      try {
        const allTags  = [...new Set([...(item.tags ?? []), ...importTags])];
        const existing = existingByPhone.get(item.phone);
        const custom   = item.customFields && Object.keys(item.customFields).length ? item.customFields : undefined;

        if (existing && mode === 'skip') { skipped++; continue; }

        let contactId: string;
        if (existing) {
          const prevCustom = (existing.customFields ?? {}) as Record<string, unknown>;
          await this.prisma.contact.update({
            where: { id: existing.id },
            data: {
              ...(item.name        && { name:        item.name }),
              ...(item.email       && { email:       item.email }),
              ...(item.company     && { company:     item.company }),
              ...(item.designation && { designation: item.designation }),
              ...(item.location    && { location:    item.location }),
              ...(item.source      && { source:      item.source }),
              ...(item.notes       && { notes:       item.notes }),
              ...(custom           && { customFields: { ...prevCustom, ...custom } as any }),
            },
          });
          contactId = existing.id;
          updated++;
        } else {
          const row = await this.prisma.contact.create({
            data: {
              name:         item.name ?? item.phone,
              phone:        item.phone,
              email:        item.email,
              company:      item.company,
              designation:  item.designation,
              location:     item.location,
              source:       item.source ?? 'import',
              notes:        item.notes,
              customFields: custom as any,
              tenantId:     scope.tenantId,
              businessId:   scope.businessId,
            },
            select: { id: true },
          });
          contactId = row.id;
          created++;
          this.dispatchContactCreated(scope, {
            id: row.id,
            name: item.name ?? item.phone,
            phone: item.phone,
          });
        }
        if (allTags.length) await this.syncTagsAdd(scope, contactId, allTags);
      } catch (err: any) {
        failed++;
        errors.push({ ref: item.phone, reason: String(err.message).slice(0, 200) });
      }
    }

    if (opts.importId) {
      await this.recordImport(scope, opts.importId, {
        mode, fileName: opts.fileName, sheetName: opts.sheetName,
        total: valid.length, created, updated, skipped, failed,
      });
    }

    return { total: valid.length, created, updated, skipped, failed, errors };
  }

  // ── Import history ─────────────────────────────────────────────────────────

  /** One row per import run; each client batch adds its counts to the same id. */
  private async recordImport(
    scope: TenantScope,
    importId: string,
    counts: { mode: string; fileName?: string; sheetName?: string; total: number; created: number; updated: number; skipped: number; failed: number },
  ) {
    const existing = await this.prisma.contactImport.findFirst({
      where: { id: importId, businessId: scope.businessId },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.contactImport.update({
        where: { id: importId },
        data: {
          total:   { increment: counts.total },
          created: { increment: counts.created },
          updated: { increment: counts.updated },
          skipped: { increment: counts.skipped },
          failed:  { increment: counts.failed },
        },
      });
      return;
    }
    await this.prisma.contactImport.create({
      data: {
        id:         importId,
        tenantId:   scope.tenantId,
        businessId: scope.businessId,
        userId:     scope.userId,
        fileName:   counts.fileName,
        sheetName:  counts.sheetName,
        mode:       counts.mode,
        total:      counts.total,
        created:    counts.created,
        updated:    counts.updated,
        skipped:    counts.skipped,
        failed:     counts.failed,
      },
    }).catch(err => {
      // Two batches of the same run can race on the first insert; fold the loser in.
      if (err?.code !== 'P2002') throw err;
      return this.recordImport(scope, importId, counts);
    });
  }

  async listImports(scope: TenantScope, limit = 20) {
    const rows = await this.prisma.contactImport.findMany({
      where:   { businessId: scope.businessId },
      orderBy: { createdAt: 'desc' },
      take:    Math.min(100, limit),
    });
    const userIds = [...new Set(rows.map(r => r.userId).filter((id): id is string => !!id))];
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
      : [];
    const byId = new Map(users.map(u => [u.id, u]));
    return rows.map(r => ({
      ...r,
      importedBy: r.userId ? (byId.get(r.userId) ?? null) : null,
    }));
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

  /**
   * Resolves label names to rows that already exist, and refuses the ones that do not.
   *
   * Labels used to be created by the act of applying one: typing anything on a contact
   * minted a new label for the whole workspace. Every typo, every singular/plural
   * variation and every half-finished word became permanent, and the list stopped being
   * usable for the segmenting and campaign targeting it exists to serve.
   *
   * So the list is now a closed set. Creating a label is a deliberate act on the labels
   * screen, which is permissioned; applying one can only pick from what is there.
   * Matching ignores case and surrounding spaces, because "VIP" and "vip " are plainly
   * the same label to the person typing them.
   */
  /** Strict: an unknown label is a mistake worth stopping for. */
  private async resolveTags(scope: TenantScope, tagNames: string[]) {
    const { found, missing } = await this.matchTags(scope, tagNames);
    if (missing.length) {
      throw new BadRequestException(
        `No such label: ${missing.join(', ')}. Create it on the Labels screen first.`,
      );
    }
    return found;
  }

  /**
   * Lenient: used by import, which is bulk and usually someone else's spreadsheet. One
   * unrecognised word in a tags column should not throw away a thousand good rows, so
   * the unknown ones come back to be reported rather than stopping the run.
   */
  private async matchTags(
    scope: TenantScope,
    tagNames: string[],
  ): Promise<{ found: { id: string; name: string }[]; missing: string[] }> {
    const wanted = [...new Set(tagNames.map((n) => n.trim()).filter(Boolean))];
    if (!wanted.length) return { found: [], missing: [] };

    const existing = await this.prisma.tag.findMany({
      where:  { tenantId: scope.tenantId, businessId: scope.businessId },
      select: { id: true, name: true },
    });
    const byName = new Map(existing.map((t) => [t.name.trim().toLowerCase(), t]));

    const found: { id: string; name: string }[] = [];
    const missing: string[] = [];
    for (const name of wanted) {
      const hit = byName.get(name.toLowerCase());
      if (hit) found.push(hit);
      else missing.push(name);
    }

    return { found, missing };
  }

  /**
   * Add labels without removing existing ones — used during import.
   *
   * @returns the names that matched nothing, so the import can report them.
   */
  private async syncTagsAdd(scope: TenantScope, contactId: string, tagNames: string[]) {
    const { found: tags, missing } = await this.matchTags(scope, tagNames);
    for (const tag of tags) {
      await this.prisma.contactTag.upsert({
        where:  { contactId_tagId: { contactId, tagId: tag.id } },
        create: { contactId, tagId: tag.id },
        update: {},
      });
    }
    return missing;
  }

  private async syncTags(scope: TenantScope, contactId: string, tagNames: string[]) {
    // Resolved before anything is removed, so a bad name leaves the contact untouched
    // rather than stripping its labels and then failing.
    const tags = await this.resolveTags(scope, tagNames);

    await this.prisma.contactTag.deleteMany({ where: { contactId } });
    for (const tag of tags) {
      // ContactTag PK is (contactId, tagId) — upsert is a no-op if it already exists
      await this.prisma.contactTag.upsert({
        where:  { contactId_tagId: { contactId, tagId: tag.id } },
        create: { contactId, tagId: tag.id },
        update: {},
      });
    }
  }
}
