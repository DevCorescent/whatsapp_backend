import {
  Controller, Get, Post, Body, Param, Query, UseGuards, HttpCode, HttpStatus, Logger,
} from '@nestjs/common';
import { ApiTags, ApiSecurity, ApiOperation } from '@nestjs/swagger';
import {
  CurrentTenant, TenantScope, decryptSecret, MessageEventsService, buildSendComponents, toSpec,
  normalizePhone,
} from '@lib/common';
import { PrismaService } from '@lib/prisma';
import { ApiKeyGuard } from './api-key.guard';
import { InboundPipelineService } from '../../../../apps/messaging/src/webhook/inbound-pipeline.service';

@ApiTags('v1 (Public API)')
@ApiSecurity('api-key')
@UseGuards(ApiKeyGuard)
@Controller('v1')
export class V1Controller {
  private readonly logger = new Logger(V1Controller.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: MessageEventsService,
    private readonly flowPipeline: InboundPipelineService,
  ) {}

  // ── Contacts ───────────────────────────────────────────────────────────────

  @Get('contacts')
  @ApiOperation({ summary: 'List contacts' })
  async listContacts(
    @CurrentTenant() scope: TenantScope,
    @Query('page')   page?: string,
    @Query('limit')  limit?: string,
    @Query('search') search?: string,
  ) {
    const p = Math.max(1, Number(page) || 1);
    const l = Math.min(100, Number(limit) || 50);
    const where: any = { tenantId: scope.tenantId, businessId: scope.businessId };
    if (search) {
      where.OR = [
        { name:  { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
      ];
    }
    const [contacts, total] = await Promise.all([
      this.prisma.contact.findMany({ where, skip: (p - 1) * l, take: l, orderBy: { createdAt: 'desc' } }),
      this.prisma.contact.count({ where }),
    ]);
    return { contacts, total, page: p, limit: l };
  }

  @Post('contacts')
  @ApiOperation({ summary: 'Create or upsert a contact by phone' })
  async upsertContact(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    const { phone: rawPhone, name, email, company, source } = body;
    if (!rawPhone || !name) return { error: 'phone and name are required' };
    // A customer's integration sends whatever it holds — "+91 98765 43210" as often as
    // "919876543210". Both have to land on one contact, not two.
    const phone = normalizePhone(rawPhone);
    if (phone.length < 8) return { error: 'phone must include the country code, like 919876543210' };
    const existing = await this.prisma.contact.findUnique({
      where: { phone_businessId: { phone, businessId: scope.businessId } },
      select: { id: true },
    });
    const contact = await this.prisma.contact.upsert({
      where:  { phone_businessId: { phone, businessId: scope.businessId } },
      create: {
        phone, name, email, company, source: source ?? 'api',
        tenantId: scope.tenantId, businessId: scope.businessId,
      },
      update: { name, email, company },
    });
    if (!existing) {
      void this.flowPipeline.triggerFlowForEvent({
        tenantId: scope.tenantId,
        businessId: scope.businessId,
        contactId: contact.id,
        trigger: 'CONTACT_CREATED',
        variables: { contactName: contact.name, contactPhone: contact.phone },
      }).catch((err) => this.logger.warn(`Could not trigger contact-created flow for ${contact.id}: ${(err as Error).message}`));
    }
    return contact;
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  @Post('messages')
  @ApiOperation({ summary: 'Send a message to a contact by phone number' })
  async sendMessage(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    const { to, text, templateName, variables } = body;
    if (!to || (!text && !templateName)) {
      return { error: 'to and (text or templateName) are required' };
    }

    // Find contact
    const contact = await this.prisma.contact.findUnique({
      where: { phone_businessId: { phone: to, businessId: scope.businessId } },
    });
    if (!contact) return { error: 'Contact not found — create the contact first via POST /v1/contacts' };

    // Find or create conversation
    let conversation = await this.prisma.conversation.findFirst({
      where: {
        contactId:  contact.id,
        businessId: scope.businessId,
        status:     'OPEN',
      },
    });
    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: {
          tenantId:   scope.tenantId,
          businessId: scope.businessId,
          contactId:  contact.id,
        },
      });
    }

    // Load integration
    const integration = await this.prisma.whatsAppIntegration.findFirst({
      where:   { businessId: scope.businessId, isActive: true },
      orderBy: { isDefault: 'desc' },
    });
    if (!integration?.accessToken) return { error: 'No active WhatsApp integration configured' };

    const accessToken = decryptSecret(integration.accessToken);
    if (!accessToken) return { error: 'WhatsApp integration token could not be decrypted' };

    let msgBody: Record<string, unknown>;
    if (templateName) {
      const tpl = await this.prisma.messageTemplate.findFirst({
        where: { name: templateName, businessId: scope.businessId, status: 'APPROVED' },
      });
      if (!tpl) return { error: `Template "${templateName}" not found or not approved` };

      // Positional values arrive as a plain array; the builder keys them by index.
      const vars: Record<string, string> = {};
      (variables?.body ?? []).forEach((v: string, i: number) => { vars[String(i + 1)] = v; });
      (variables?.header ?? []).forEach((v: string, i: number) => { vars[`header_${i + 1}`] = v; });
      const comps = buildSendComponents(toSpec(tpl), {
        variables: vars,
        headerMediaId:  variables?.headerMediaId ?? null,
        headerMediaUrl: variables?.headerMediaUrl ?? null,
      });
      msgBody = {
        messaging_product: 'whatsapp', to,
        type: 'template',
        template: { name: templateName, language: { code: tpl.language }, components: comps.length ? comps : undefined },
      };
    } else {
      msgBody = { messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } };
    }

    const res = await fetch(
      `https://graph.facebook.com/v20.0/${integration.phoneNumberId}/messages`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(msgBody),
      },
    );

    const json = await res.json() as any;
    if (!res.ok) return { error: json?.error?.message ?? 'WhatsApp API error', raw: json };

    const waMessageId = json?.messages?.[0]?.id;
    const message = await this.prisma.message.create({
      data: {
        tenantId:       scope.tenantId,
        businessId:     scope.businessId,
        conversationId: conversation.id,
        direction:      'OUTBOUND',
        type:           templateName ? 'TEMPLATE' : 'TEXT',
        content:        text,
        status:         'SENT',
        waMessageId,
        isAiGenerated:  false,
      },
    });

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data:  { lastMessageAt: new Date(), lastMessagePreview: text?.slice(0, 100) ?? templateName },
    });
    void this.events.messageNew(message.id);

    return { messageId: message.id, waMessageId };
  }

  // ── Templates ──────────────────────────────────────────────────────────────

  @Get('templates')
  @ApiOperation({ summary: 'List approved message templates' })
  async listTemplates(@CurrentTenant() scope: TenantScope, @Query('search') search?: string) {
    const where: any = { tenantId: scope.tenantId, businessId: scope.businessId, status: 'APPROVED' };
    if (search) where.name = { contains: search, mode: 'insensitive' };
    return this.prisma.messageTemplate.findMany({ where, orderBy: { name: 'asc' } });
  }
}
