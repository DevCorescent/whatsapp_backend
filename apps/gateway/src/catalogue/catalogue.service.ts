import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope, decryptSecret, WA_API_VERSION } from '@lib/common';

export interface CatalogueProduct {
  id: string;
  retailerId: string;
  name: string;
  description: string | null;
  price: string | null;
  currency: string | null;
  availability: string | null;
  imageUrl: string | null;
  url: string | null;
}

/**
 * The WhatsApp product catalogue.
 *
 * Products live in Meta's Commerce Manager and are read from there on demand rather than
 * copied here. A copy would give two answers to "what does this cost", and the wrong one
 * would be ours — a customer being shown a stale price is worse than a list that takes a
 * moment to load.
 *
 * What this adds is the part Commerce Manager does not do: connecting a catalogue to a
 * number, listing it where the rest of the work happens, and sending a product into a
 * conversation.
 */
@Injectable()
export class CatalogueService {
  private readonly logger = new Logger(CatalogueService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async integration(scope: TenantScope, integrationId?: string) {
    const row = integrationId
      ? await this.prisma.whatsAppIntegration.findFirst({
          where: { id: integrationId, businessId: scope.businessId, tenantId: scope.tenantId },
        })
      : await this.prisma.whatsAppIntegration.findFirst({
          where: { businessId: scope.businessId, tenantId: scope.tenantId, isActive: true, isDefault: true },
        });
    if (!row) throw new NotFoundException('No WhatsApp number found for this department');

    const token = row.accessToken ? decryptSecret(row.accessToken) : null;
    if (!token) throw new BadRequestException('This WhatsApp number has no usable access token');
    return { row, token };
  }

  /** Which catalogue, if any, each of this department's numbers is connected to. */
  async status(scope: TenantScope) {
    const rows = await this.prisma.whatsAppIntegration.findMany({
      where:  { businessId: scope.businessId, tenantId: scope.tenantId, isActive: true },
      select: { id: true, displayName: true, phoneNumber: true, catalogId: true, isDefault: true },
      orderBy: { isDefault: 'desc' },
    });
    return rows.map((r) => ({ ...r, connected: Boolean(r.catalogId) }));
  }

  /**
   * Points a number at a catalogue, after checking Meta agrees it exists and is readable.
   *
   * Verified rather than trusted: a mistyped id stored now would surface much later as an
   * empty product list, with nothing to say which of the two was wrong.
   */
  async connect(scope: TenantScope, body: { catalogId: string; integrationId?: string }) {
    const { row, token } = await this.integration(scope, body.integrationId);
    const catalogId = body.catalogId?.trim();
    if (!catalogId) throw new BadRequestException('catalogId is required.');

    const res = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/${catalogId}?fields=id,name`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const body2 = await res.json().catch(() => null);
      throw new BadRequestException(
        body2?.error?.message ??
        'Meta could not read that catalogue. Check the id, and that this number\'s business owns it.',
      );
    }
    const meta = (await res.json()) as { id: string; name?: string };

    await this.prisma.whatsAppIntegration.update({
      where: { id: row.id },
      data:  { catalogId: meta.id },
    });
    return { integrationId: row.id, catalogId: meta.id, name: meta.name ?? null };
  }

  async disconnect(scope: TenantScope, integrationId?: string) {
    const { row } = await this.integration(scope, integrationId);
    await this.prisma.whatsAppIntegration.update({ where: { id: row.id }, data: { catalogId: null } });
    return { integrationId: row.id, connected: false };
  }

  /**
   * The products in the connected catalogue.
   *
   * @param after Meta's cursor. Catalogues run to thousands of items, so they are paged
   *   rather than fetched whole — the screen asks for more when it needs them.
   */
  async products(scope: TenantScope, query: { integrationId?: string; search?: string; after?: string } = {}) {
    const { row, token } = await this.integration(scope, query.integrationId);
    if (!row.catalogId) {
      throw new BadRequestException('No catalogue is connected to this number yet.');
    }

    const params = new URLSearchParams({
      fields: 'id,retailer_id,name,description,price,currency,availability,image_url,url',
      limit:  '50',
    });
    if (query.after) params.set('after', query.after);
    // Meta filters server-side, which keeps a large catalogue off this machine entirely.
    if (query.search?.trim()) {
      params.set('filter', JSON.stringify({ name: { i_contains: query.search.trim() } }));
    }

    const res = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/${row.catalogId}/products?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new BadRequestException(json?.error?.message ?? 'Could not read the catalogue from Meta');
    }

    const products: CatalogueProduct[] = (json?.data ?? []).map((p: Record<string, unknown>) => ({
      id:           String(p.id),
      retailerId:   String(p.retailer_id ?? ''),
      name:         String(p.name ?? ''),
      description:  (p.description as string) ?? null,
      price:        (p.price as string) ?? null,
      currency:     (p.currency as string) ?? null,
      availability: (p.availability as string) ?? null,
      imageUrl:     (p.image_url as string) ?? null,
      url:          (p.url as string) ?? null,
    }));

    return { products, next: json?.paging?.cursors?.after ?? null, catalogId: row.catalogId };
  }

  /**
   * Sends one product, or a set of them, into a conversation.
   *
   * Items are named by their retailer id — the code the business uses in its own
   * catalogue — because that is what someone reading the list recognises, and what Meta
   * expects in the message.
   */
  async sendProducts(
    scope: TenantScope,
    body: { conversationId: string; retailerIds: string[]; bodyText?: string; footerText?: string },
  ) {
    if (!body.retailerIds?.length) throw new BadRequestException('retailerIds is required.');

    const conversation = await this.prisma.conversation.findFirst({
      where:   { id: body.conversationId, tenantId: scope.tenantId, businessId: scope.businessId },
      include: { contact: { select: { phone: true } } },
    });
    if (!conversation) throw new NotFoundException('That conversation is not in this department');

    const { row, token } = await this.integration(scope, conversation.whatsappIntegrationId ?? undefined);
    if (!row.catalogId) throw new BadRequestException('No catalogue is connected to this number yet.');

    const single = body.retailerIds.length === 1;
    const interactive = single
      ? {
          type: 'product',
          body: body.bodyText ? { text: body.bodyText } : undefined,
          action: { catalog_id: row.catalogId, product_retailer_id: body.retailerIds[0] },
        }
      : {
          type: 'product_list',
          header: { type: 'text', text: body.bodyText?.slice(0, 60) || 'Our products' },
          body:   { text: body.bodyText || 'Here is what we have.' },
          footer: body.footerText ? { text: body.footerText } : undefined,
          action: {
            catalog_id: row.catalogId,
            sections: [{
              title: 'Products',
              product_items: body.retailerIds.map((id) => ({ product_retailer_id: id })),
            }],
          },
        };

    const res = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/${row.phoneNumberId}/messages`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: conversation.contact.phone,
          type: 'interactive',
          interactive,
        }),
      },
    );
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new BadRequestException(json?.error?.message ?? 'WhatsApp refused the product message');
    }

    this.logger.log(`Sent ${body.retailerIds.length} product(s) to conversation ${conversation.id}`);
    return { sent: true, waMessageId: json?.messages?.[0]?.id ?? null };
  }
}
