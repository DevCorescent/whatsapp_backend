import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

/**
 * Hand-picked groups of contacts.
 *
 * A segment is a saved rule, re-run every time it is used, so the people in it change
 * as the data does. A list is the other thing someone means by "my group": a set chosen
 * by hand, which stays exactly as it was left. Broadcasting to one should send to the
 * people who were in it, not to whoever happens to match a rule at send time.
 *
 * Everything here is scoped to a department as well as a tenant, because contacts are.
 */
@Injectable()
export class ContactListsService {
  constructor(private readonly prisma: PrismaService) {}

  private scopeWhere(scope: TenantScope) {
    return { tenantId: scope.tenantId, businessId: scope.businessId };
  }

  async list(scope: TenantScope) {
    const rows = await this.prisma.withRetry(
      () => this.prisma.contactList.findMany({
        where:   this.scopeWhere(scope),
        orderBy: { name: 'asc' },
        include: { _count: { select: { members: true } } },
      }),
      'contact lists',
    );
    return rows.map(({ _count, ...rest }) => ({ ...rest, contactCount: _count.members }));
  }

  /** One list with its members, for the screen that edits it. */
  async get(scope: TenantScope, id: string) {
    const list = await this.prisma.contactList.findFirst({
      where:   { id, ...this.scopeWhere(scope) },
      include: {
        members: {
          orderBy: { addedAt: 'desc' },
          include: { contact: { select: { id: true, name: true, phone: true, email: true } } },
        },
      },
    });
    if (!list) throw new NotFoundException('That list does not exist here');

    const { members, ...rest } = list;
    return {
      ...rest,
      contactCount: members.length,
      contacts: members.map((m) => ({ ...m.contact, addedAt: m.addedAt })),
    };
  }

  async create(scope: TenantScope, body: { name?: string; description?: string; userId?: string }) {
    const name = body.name?.trim();
    if (!name) throw new BadRequestException('name is required.');

    const clash = await this.prisma.contactList.findFirst({
      where: { name, businessId: scope.businessId },
      select: { id: true },
    });
    if (clash) throw new ConflictException(`A list called "${name}" already exists.`);

    return this.prisma.contactList.create({
      data: {
        tenantId:    scope.tenantId,
        businessId:  scope.businessId,
        name,
        description: body.description?.trim() || null,
        createdById: body.userId ?? null,
      },
    });
  }

  async update(scope: TenantScope, id: string, body: { name?: string; description?: string }) {
    await this.get(scope, id);

    const name = body.name?.trim();
    if (name) {
      const clash = await this.prisma.contactList.findFirst({
        where:  { name, businessId: scope.businessId, id: { not: id } },
        select: { id: true },
      });
      if (clash) throw new ConflictException(`A list called "${name}" already exists.`);
    }

    return this.prisma.contactList.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(body.description !== undefined ? { description: body.description?.trim() || null } : {}),
      },
    });
  }

  async remove(scope: TenantScope, id: string) {
    await this.get(scope, id);
    // Members go with it through the cascade; the contacts themselves are untouched.
    await this.prisma.contactList.delete({ where: { id } });
    return { success: true };
  }

  /**
   * @returns how many were actually added, so the screen can say "4 added, 2 already in"
   *   rather than claiming it added six.
   */
  async addContacts(scope: TenantScope, id: string, contactIds: string[]) {
    await this.get(scope, id);
    const wanted = [...new Set((contactIds ?? []).filter(Boolean))];
    if (!wanted.length) throw new BadRequestException('contactIds is required.');

    // Only contacts of this department may join, checked here rather than trusted from
    // the request — ids travel through the browser and a list is a sending target.
    const allowed = await this.prisma.contact.findMany({
      where:  { id: { in: wanted }, ...this.scopeWhere(scope) },
      select: { id: true },
    });
    if (!allowed.length) throw new BadRequestException('None of those contacts are in this department.');

    const result = await this.prisma.contactListMember.createMany({
      data:           allowed.map((c) => ({ listId: id, contactId: c.id })),
      skipDuplicates: true,
    });

    return {
      success:      true,
      added:        result.count,
      alreadyIn:    allowed.length - result.count,
      notInBusiness: wanted.length - allowed.length,
    };
  }

  async removeContacts(scope: TenantScope, id: string, contactIds: string[]) {
    await this.get(scope, id);
    const wanted = [...new Set((contactIds ?? []).filter(Boolean))];
    if (!wanted.length) throw new BadRequestException('contactIds is required.');

    const result = await this.prisma.contactListMember.deleteMany({
      where: { listId: id, contactId: { in: wanted } },
    });
    return { success: true, removed: result.count };
  }

  /**
   * The contact ids behind a set of lists, deduplicated.
   *
   * Used when a campaign names lists as its audience. Returns ids rather than contacts
   * because the caller turns them into recipient rows and does not need the detail.
   */
  async contactIdsFor(scope: TenantScope, listIds: string[]): Promise<string[]> {
    const ids = [...new Set((listIds ?? []).filter(Boolean))];
    if (!ids.length) return [];

    const lists = await this.prisma.contactList.findMany({
      where:  { id: { in: ids }, ...this.scopeWhere(scope) },
      select: { id: true },
    });
    const missing = ids.filter((i) => !lists.some((l) => l.id === i));
    if (missing.length) throw new BadRequestException('One of those contact lists does not exist here.');

    const members = await this.prisma.contactListMember.findMany({
      where:  { listId: { in: ids } },
      select: { contactId: true },
    });
    return [...new Set(members.map((m) => m.contactId))];
  }
}
