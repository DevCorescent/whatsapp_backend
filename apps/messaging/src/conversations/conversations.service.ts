import {
  Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger,
} from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import {
  TenantScope, decryptSecret, MessageEventsService, NotificationsService,
  HandoverService, LeadQualificationService,
  parseSendError, classifySendError, describeSendError, isKnownSendError,
  normalizePhone, toSpec, buildSendComponents, missingSendValues, describeMissing,
  dynamicUrlButtonIndexes, TEAM_ADMIN_ROLES, type TemplateSpec,
} from '@lib/common';

/**
 * The template's body with its variables filled in, so the thread shows what the customer
 * received rather than the raw `{{1}}` the template was written with.
 */
function renderTemplateBody(spec: TemplateSpec, variables: Record<string, string>): string {
  return (spec.body ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key) => variables[key] ?? whole);
}

const WA_API_VERSION = process.env.WHATSAPP_API_VERSION ?? 'v20.0';

const MEDIA_PREVIEW: Record<string, string> = {
  image: '📷 Photo', video: '🎥 Video', audio: '🎵 Voice message', document: '📄 Document', sticker: '😊 Sticker',
};

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: MessageEventsService,
    private readonly notifications: NotificationsService,
    private readonly handover: HandoverService,
    private readonly qualification: LeadQualificationService,
  ) {}

  // ── List ───────────────────────────────────────────────────────────────────

  async findAll(scope: TenantScope, query: {
    page?: number; limit?: number; status?: string; search?: string;
    assignedToId?: string; isAiActive?: boolean; whatsappIntegrationId?: string;
  }) {
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 30);
    const skip  = (page - 1) * limit;

    const where: any = { tenantId: scope.tenantId, businessId: scope.businessId };
    if (query.status)        where.status      = query.status;
    if (query.assignedToId)  where.assignedToId = query.assignedToId;
    if (query.isAiActive != null) where.isAiActive = query.isAiActive;
    // A workspace can connect several WhatsApp numbers, and a thread belongs to the one
    // it arrived on. Filtering by it is how someone works one number's inbox at a time.
    if (query.whatsappIntegrationId) where.whatsappIntegrationId = query.whatsappIntegrationId;
    if (query.search) {
      where.contact = { OR: [
        { name:  { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search } },
      ]};
    }

    const [conversations, total] = await Promise.all([
      this.prisma.conversation.findMany({
        where, skip, take: limit,
        orderBy: { lastMessageAt: 'desc' },
        include: {
          contact:    { select: { id: true, name: true, phone: true, avatarUrl: true } },
          assignedTo: { select: { id: true, name: true, email: true } },
          // Which number the thread is on, so the list can label it when there is
          // more than one and a reply's origin is not obvious.
          whatsappIntegration: {
            select: { id: true, displayName: true, phoneNumber: true },
          },
        },
      }),
      this.prisma.conversation.count({ where }),
    ]);

    return { success: true, data: conversations, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }, businessId: scope.businessId };
  }

  // ── Get one ────────────────────────────────────────────────────────────────

  async findOne(scope: TenantScope, id: string, query: { page?: number } = {}) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id, tenantId: scope.tenantId, businessId: scope.businessId },
      include: {
        contact:    true,
        assignedTo: { select: { id: true, name: true, email: true } },
      },
    });
    if (!conv) throw new NotFoundException('Conversation not found');

    const pageSize = 50;
    // page 1 = most recent 50; page 2 = the 50 before that; etc.
    const page = Math.max(1, query.page ?? 1);
    const msgTotal = await this.prisma.message.count({ where: { conversationId: id, tenantId: scope.tenantId } });
    // skip from the end so page 1 is always the newest messages
    const skipFromEnd = (page - 1) * pageSize;
    const messages = await this.prisma.message.findMany({
      where:   { conversationId: id, tenantId: scope.tenantId },
      orderBy: { createdAt: 'desc' },
      skip:    skipFromEnd,
      take:    pageSize,
      include: { sentBy: { select: { id: true, name: true } } },
    });
    messages.reverse(); // display oldest → newest in the chat window
    // Reset unread count
    await this.prisma.conversation.update({ where: { id }, data: { unreadCount: 0 } });

    return {
      success: true,
      data: {
        ...conv,
        messages,
        serviceWindow: await this.serviceWindow(scope, id),
        pagination: { page, pageSize, total: msgTotal, totalPages: Math.ceil(msgTotal / pageSize) },
      },
    };
  }

  /**
   * Whether a plain message can still reach this person.
   *
   * WhatsApp only carries free-form messages for 24 hours after the customer last wrote;
   * outside that, the one thing that reaches them is an approved template. Nothing here
   * knew that, so an agent typed a reply, watched it appear in the thread, and it was
   * refused by Meta seconds later with "more than 24 hours since they last replied" —
   * wording the agent never saw, on a message that still looked sent.
   */
  async serviceWindow(scope: TenantScope, conversationId: string) {
    const lastInbound = await this.prisma.message.findFirst({
      where:   { conversationId, tenantId: scope.tenantId, direction: 'INBOUND' },
      orderBy: { createdAt: 'desc' },
      select:  { createdAt: true },
    });
    if (!lastInbound) {
      return { open: false, lastInboundAt: null, expiresAt: null, everReplied: false };
    }
    const expiresAt = new Date(lastInbound.createdAt.getTime() + 24 * 60 * 60_000);
    return {
      open: expiresAt.getTime() > Date.now(),
      lastInboundAt: lastInbound.createdAt,
      expiresAt,
      everReplied: true,
    };
  }

  // ── Starting a chat with someone new ───────────────────────────────────────

  /**
   * Opens a chat with a number, whether or not it is already a contact.
   *
   * Until now a conversation could only begin with the customer writing first, so a
   * business that had someone's number and wanted to reach out had nowhere in the inbox
   * to do it. The contact and the thread are created if they are missing, and an existing
   * thread is returned rather than duplicated.
   *
   * Nothing is sent here. Whether this can carry a plain message or has to be a template
   * is the service window's answer, and the caller asks it next.
   */
  async startConversation(scope: TenantScope, body: { phone?: string; name?: string }) {
    const phone = normalizePhone(body?.phone ?? '');
    if (phone.length < 8 || phone.length > 15) {
      throw new BadRequestException('Enter a phone number with its country code, like 919876543210.');
    }

    const integration = await this.prisma.whatsAppIntegration.findFirst({
      where:   { businessId: scope.businessId, tenantId: scope.tenantId, isActive: true },
      orderBy: { isDefault: 'desc' },
      select:  { id: true },
    });
    if (!integration) throw new BadRequestException('Connect a WhatsApp number first.');

    const name = body?.name?.trim();
    const contact = await this.prisma.contact.upsert({
      where:  { phone_businessId: { phone, businessId: scope.businessId } },
      create: {
        tenantId: scope.tenantId, businessId: scope.businessId,
        phone, name: name || phone, source: 'inbox',
      },
      // An existing contact keeps the name it has; a blank one takes the given one.
      update: name ? { name: undefined } : {},
      select: { id: true, name: true, phone: true },
    });

    const existing = await this.prisma.conversation.findFirst({
      where:  { contactId: contact.id, tenantId: scope.tenantId, businessId: scope.businessId },
      select: { id: true },
    });
    if (existing) {
      return { success: true, data: { conversationId: existing.id, contact, created: false } };
    }

    const conversation = await this.prisma.conversation.create({
      data: {
        tenantId:   scope.tenantId,
        businessId: scope.businessId,
        contactId:  contact.id,
        whatsappIntegrationId: integration.id,
        status:     'OPEN',
        channel:    'WHATSAPP',
      },
      select: { id: true },
    });
    return { success: true, data: { conversationId: conversation.id, contact, created: true } };
  }

  // ── Sending an approved template into a chat ───────────────────────────────

  /**
   * The only message that reaches someone outside the 24-hour window, and therefore the
   * only way to open a conversation that the customer did not start.
   *
   * Refused rather than attempted when the template is missing a value, so the agent is
   * told which field is empty instead of watching the message fail at Meta.
   */
  async sendTemplate(scope: TenantScope, conversationId: string, body: {
    templateId?: string;
    bodyVarMapping?: string[];
    urlButtonMapping?: string[];
    headerVarMapping?: string[];
    headerMediaId?: string | null;
    headerMediaUrl?: string | null;
  }) {
    const conv = await this.prisma.conversation.findFirst({
      where:   { id: conversationId, tenantId: scope.tenantId, businessId: scope.businessId },
      include: { contact: { select: { phone: true, waId: true, name: true } } },
    });
    if (!conv) throw new NotFoundException('Conversation not found');
    if (!body?.templateId) throw new BadRequestException('Choose a template');

    const integration = conv.whatsappIntegrationId
      ? await this.prisma.whatsAppIntegration.findUnique({ where: { id: conv.whatsappIntegrationId } })
      : await this.prisma.whatsAppIntegration.findFirst({
          where:   { businessId: scope.businessId, isActive: true },
          orderBy: { isDefault: 'desc' },
        });
    if (!integration?.accessToken) throw new BadRequestException('No active WhatsApp number');

    const template = await this.prisma.messageTemplate.findFirst({
      where: { id: body.templateId, tenantId: scope.tenantId, businessId: scope.businessId },
    });
    if (!template || template.status !== 'APPROVED') {
      throw new BadRequestException('Choose an approved WhatsApp template');
    }
    // A media id belongs to the number it was uploaded to, and a template to its account.
    if (template.wabaId && template.wabaId !== integration.whatsappBusinessId) {
      throw new BadRequestException('This template belongs to a different WhatsApp number');
    }

    const spec = toSpec(template);
    const missing = missingSendValues(spec, {
      bodyVarMapping:   body.bodyVarMapping,
      urlButtonMapping: body.urlButtonMapping,
      headerVarMapping: body.headerVarMapping,
      headerMediaId:    body.headerMediaId,
      headerMediaUrl:   body.headerMediaUrl,
      phones:           [],
    });
    if (missing.length) throw new BadRequestException(describeMissing(missing));

    const variables: Record<string, string> = {};
    (body.bodyVarMapping ?? []).forEach((v, i) => { variables[`${i + 1}`] = v ?? ''; });
    (body.headerVarMapping ?? []).forEach((v, i) => { variables[`header_${i + 1}`] = v ?? ''; });
    dynamicUrlButtonIndexes(spec).forEach((buttonIndex, slot) => {
      variables[`url_${buttonIndex + 1}`] = (body.urlButtonMapping ?? [])[slot] ?? '';
    });

    const components = buildSendComponents(spec, {
      variables,
      headerMediaId:  body.headerMediaId ?? null,
      headerMediaUrl: body.headerMediaUrl ?? null,
    });

    const to = conv.contact.phone ?? conv.contact.waId ?? '';
    if (!to) throw new BadRequestException('Contact has no phone number');

    const accessToken = decryptSecret(integration.accessToken);
    if (!accessToken) throw new BadRequestException('WhatsApp access token could not be read');

    const res = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/${integration.phoneNumberId}/messages`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name:       template.name,
            language:   { code: template.language },
            components: components.length ? components : undefined,
          },
        }),
      },
    );
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const parsed = parseSendError(res.status, json);
      // Meta already explains itself; our sentence says what to do about it.
      throw new BadRequestException(describeSendError(parsed, classifySendError(parsed.code, parsed.subcode)));
    }

    const waMessageId = json?.messages?.[0]?.id ?? null;
    const preview = `${template.name}`;
    const message = await this.prisma.message.create({
      data: {
        tenantId:   scope.tenantId,
        businessId: scope.businessId,
        conversationId,
        sentById:   scope.userId,
        waMessageId,
        direction:  'OUTBOUND',
        type:       'TEMPLATE' as any,
        content:    renderTemplateBody(spec, variables),
        metadata:   { templateName: template.name, templateId: template.id } as any,
        status:     'SENT',
        isNote:     false,
      },
      include: { sentBy: { select: { id: true, name: true } } },
    });

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data:  { lastMessageAt: message.createdAt, lastMessagePreview: preview.slice(0, 100) },
    });

    // Same path a typed reply takes, so the thread and the list update for everyone
    // watching rather than only for whoever pressed send.
    void this.events.messageNew(message.id);
    void this.events.conversationUpdated(conversationId);
    return { success: true, data: message };
  }

  // ── Internal notes ─────────────────────────────────────────────────────────

  /** Every note on this chat, newest first. Notes are never sent to WhatsApp. */
  async listNotes(scope: TenantScope, conversationId: string) {
    await this.findOne(scope, conversationId); // 404 guard
    const notes = await this.prisma.message.findMany({
      where:   { conversationId, tenantId: scope.tenantId, isNote: true },
      orderBy: { createdAt: 'desc' },
      include: { sentBy: { select: { id: true, name: true } } },
    });
    return { notes, total: notes.length };
  }

  /**
   * Take a note back.
   *
   * Notes only — the same row type carries sent messages, and a message that reached
   * someone's phone cannot be unsent by deleting our copy of it, so the filter is part
   * of the lookup rather than a check afterwards.
   *
   * Yours to remove, or an owner's or admin's: a note is usually a mistyped line or
   * something that stopped being true, and waiting for the person who wrote it to come
   * back from leave is not a useful rule. Everyone else's stays put.
   */
  async deleteNote(scope: TenantScope, conversationId: string, noteId: string) {
    await this.findOne(scope, conversationId); // 404 guard
    const note = await this.prisma.message.findFirst({
      where:  { id: noteId, conversationId, tenantId: scope.tenantId, isNote: true },
      select: { id: true, sentById: true },
    });
    if (!note) throw new NotFoundException('Note not found');

    const canRemoveAnyones = (TEAM_ADMIN_ROLES as readonly string[]).includes(scope.role);
    if (note.sentById !== scope.userId && !canRemoveAnyones) {
      throw new ForbiddenException('Only the person who left this note can remove it.');
    }

    await this.prisma.message.delete({ where: { id: note.id } });
    return { success: true, id: note.id };
  }

  // ── Messages in a conversation ─────────────────────────────────────────────

  async getMessages(scope: TenantScope, conversationId: string, query: {
    page?: number; limit?: number;
  }) {
    await this.findOne(scope, conversationId); // 404 guard

    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 50);

    const total = await this.prisma.message.count({ where: { conversationId, tenantId: scope.tenantId } });
    const skipFromEnd = (page - 1) * limit;
    const messages = await this.prisma.message.findMany({
      where:   { conversationId, tenantId: scope.tenantId },
      orderBy: { createdAt: 'desc' },
      skip:    skipFromEnd,
      take:    limit,
      include: { sentBy: { select: { id: true, name: true } } },
    });
    messages.reverse();

    // Mark conversation as read
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data:  { unreadCount: 0 },
    });

    return { messages, total, page, limit };
  }

  // ── Update conversation ────────────────────────────────────────────────────

  async update(scope: TenantScope, id: string, data: {
    status?: string; isAiActive?: boolean; assignedToId?: string | null;
    labels?: string[]; unreadCount?: number;
  }) {
    const exists = await this.prisma.conversation.findFirst({
      where:  { id, tenantId: scope.tenantId, businessId: scope.businessId },
      select: { id: true, assignedToId: true, contact: { select: { name: true, phone: true } } },
    });
    if (!exists) throw new NotFoundException('Conversation not found');

    const updated = await this.prisma.conversation.update({
      where: { id },
      data:  {
        status:       data.status as any,
        isAiActive:   data.isAiActive,
        assignedToId: data.assignedToId,
        labels:       data.labels,
        ...(data.unreadCount === 0 ? { unreadCount: 0 } : {}),
      },
    });
    void this.events.conversationUpdated(id);

    const newAssignee = data.assignedToId;
    if (newAssignee && newAssignee !== exists.assignedToId && newAssignee !== scope.userId) {
      void this.notifications.notify({
        tenantId:   scope.tenantId,
        businessId: scope.businessId,
        recipients: { userIds: [newAssignee] },
        type:       'CONVERSATION_ASSIGNED',
        title:      `Conversation assigned to you`,
        body:       exists.contact.name || exists.contact.phone || undefined,
        href:       `/inbox?c=${id}`,
        data:       { conversationId: id },
      });
    }

    // Closing the thread settles any handover waiting on it, and is the last chance to
    // judge it as a lead for a workspace that scores on close.
    if (data.status === 'CLOSED') {
      void this.handover.resolveForConversation(id);
      void this.qualifyOnClose(id);
    }
    return updated;
  }

  /** Score the conversation if this workspace asked for that to happen on close. */
  private async qualifyOnClose(conversationId: string): Promise<void> {
    try {
      if (await this.qualification.isDue(conversationId, 'ON_CLOSE')) {
        await this.qualification.qualify(conversationId);
      }
    } catch (err: any) {
      this.logger.warn(`Could not score ${conversationId} on close: ${err?.message ?? err}`);
    }
  }

  // ── Send outbound message ──────────────────────────────────────────────────

  async sendMessage(scope: TenantScope, conversationId: string, payload: {
    text?: string; mediaUrl?: string; mediaId?: string; mediaType?: string;
    mediaMimeType?: string; mediaSize?: number; fileName?: string; storageKey?: string; type?: string; isNote?: boolean;
    interactive?: Record<string, unknown>; replyToId?: string; clientId?: string;
  }) {
    this.logger.log(`sendMessage start — conversationId=${conversationId} tenantId=${scope.tenantId} businessId=${scope.businessId} type=${payload.type ?? 'TEXT'} isNote=${payload.isNote}`);

    const conv = await this.prisma.conversation.findFirst({
      where:   { id: conversationId, tenantId: scope.tenantId, businessId: scope.businessId },
      include: { contact: { select: { phone: true, waId: true } } },
    });
    if (!conv) throw new NotFoundException('Conversation not found');

    const isInteractive = (payload.type ?? '').toUpperCase() === 'INTERACTIVE';
    const hasMedia = Boolean(payload.mediaUrl || payload.mediaId);
    if (!payload.text && !hasMedia && !isInteractive) {
      this.logger.warn('sendMessage — missing text/media/interactive');
      throw new BadRequestException('Either text, media, or interactive payload is required');
    }

    // A note is written for the team and never leaves the building, so none of what
    // sending needs applies to it: no number to send from, no token to send with, no
    // number to send to. Demanding them anyway meant an expired token or a contact with
    // no phone also stopped anyone leaving a note — which is exactly the moment a note
    // is worth writing.
    let waMessageId: string | null = null;
    if (!payload.isNote) {
      const integration = conv.whatsappIntegrationId
        ? await this.prisma.whatsAppIntegration.findUnique({
            where: { id: conv.whatsappIntegrationId },
          })
        : await this.prisma.whatsAppIntegration.findFirst({
            where: { businessId: scope.businessId, isActive: true },
          });

      this.logger.log(`sendMessage integration — found=${!!integration} phoneNumberId=${integration?.phoneNumberId ?? 'null'} hasToken=${!!(integration?.accessToken)}`);

      if (!integration) throw new BadRequestException('No active WhatsApp integration found');
      if (!integration.accessToken) throw new BadRequestException('WhatsApp integration has no access token');

      const to = conv.contact.phone ?? conv.contact.waId ?? '';
      this.logger.log(`sendMessage contact — to=${to ? to.slice(0, 6) + '***' : 'MISSING'}`);
      if (!to) throw new BadRequestException('Contact has no phone number');

      const accessToken = decryptSecret(integration.accessToken);
      if (!accessToken) throw new BadRequestException('WhatsApp integration access token could not be decrypted — check ENCRYPTION_KEY');
      waMessageId = await this.sendWhatsApp(integration.phoneNumberId, accessToken, to, payload);
      this.logger.log(`sendMessage ← Meta API OK waMessageId=${waMessageId ?? 'none'}`);
    }

    const mediaKind = (payload.mediaType ?? (hasMedia ? (payload.type ?? '').toLowerCase() : '')).toLowerCase();
    const metadata: Record<string, unknown> = {};
    if (payload.interactive) metadata.interactive = payload.interactive;
    if (payload.mediaId)     metadata.mediaId = payload.mediaId;
    if (payload.storageKey)  metadata.storageKey = payload.storageKey;
    if (payload.fileName)    metadata.filename = payload.fileName;
    if (payload.clientId)    metadata.clientId = payload.clientId;

    const message = await this.prisma.message.create({
      data: {
        tenantId:       scope.tenantId,
        businessId:     scope.businessId,
        conversationId,
        sentById:       scope.userId,
        waMessageId,
        direction:      'OUTBOUND',
        type:           (payload.type ?? 'TEXT') as any,
        content:        payload.text ?? null,
        mediaUrl:       payload.mediaUrl ?? null,
        mediaType:      payload.mediaType ?? null,
        mediaMimeType:  payload.mediaMimeType ?? null,
        mediaSize:      payload.mediaSize ?? null,
        metadata:       Object.keys(metadata).length ? (metadata as any) : undefined,
        status:         payload.isNote ? 'DELIVERED' : 'SENT',
        isNote:         payload.isNote ?? false,
        isAiGenerated:  false,
        replyToId:      payload.replyToId ?? null,
      },
      include: { sentBy: { select: { id: true, name: true } } },
    });
    this.logger.log(`sendMessage saved — messageId=${message.id}`);

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data:  {
        lastMessageAt:      message.createdAt,
        lastMessagePreview: payload.text?.slice(0, 100)
          ?? (hasMedia ? (MEDIA_PREVIEW[mediaKind] ?? '📎 Attachment') : (isInteractive ? '💬 Interactive' : '')),
      },
    });

    void this.events.messageNew(message.id);
    this.logger.log(`sendMessage done — messageId=${message.id}`);
    return message;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  /** Sends via Meta Graph and returns the WhatsApp message id (`wamid.…`) for status tracking. */
  private async sendWhatsApp(
    phoneNumberId: string,
    accessToken:   string,
    to:            string,
    payload:       {
      text?: string; mediaUrl?: string; mediaId?: string; type?: string; fileName?: string;
      interactive?: Record<string, unknown>; replyToId?: string;
    },
  ): Promise<string | null> {
    const type = (payload.type ?? 'text').toLowerCase();
    let body: Record<string, unknown>;

    if (type === 'interactive' && payload.interactive) {
      body = { type: 'interactive', interactive: payload.interactive };
    } else if (type === 'text' || (!payload.mediaUrl && !payload.mediaId)) {
      body = { type: 'text', text: { body: payload.text, preview_url: false } };
    } else {
      const media: Record<string, unknown> = payload.mediaId ? { id: payload.mediaId } : { link: payload.mediaUrl };
      if (payload.text && type !== 'audio' && type !== 'sticker') media.caption = payload.text;
      if (type === 'document' && payload.fileName) media.filename = payload.fileName;
      body = { type, [type]: media };
    }

    const apiBody: Record<string, unknown> = { messaging_product: 'whatsapp', to, ...body };
    if (payload.replyToId) {
      // Meta wants the WhatsApp id of the quoted message, not our row id.
      const quoted = await this.prisma.message.findUnique({ where: { id: payload.replyToId }, select: { waMessageId: true } });
      if (quoted?.waMessageId) apiBody.context = { message_id: quoted.waMessageId };
    }

    const metaUrl = `https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/messages`;
    this.logger.log(`sendWhatsApp → ${metaUrl} type=${type}`);

    const res = await fetch(metaUrl, {
      method:  'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(apiBody),
    });

    const responseText = await res.text();
    if (!res.ok) {
      this.logger.error(`sendWhatsApp ← Meta ${res.status} ${res.statusText}: ${responseText.slice(0, 600)}`);
      // Meta's own wording names Graph objects by id ("Object with ID '130...' does not
      // exist"), which tells an agent staring at a chat window nothing it can act on.
      // The shared rules turn the known failures into a sentence that names the fix.
      let body: unknown = null;
      try { body = JSON.parse(responseText); } catch { /* not JSON — keep the raw text */ }
      const parsed = parseSendError(res.status, body);
      if (parsed.code != null) {
        const rule = classifySendError(parsed.code, parsed.subcode);
        // A code we recognise already carries the sentence worth showing, and Meta's own
        // wording would only add Graph object ids to it. An unrecognised code is the
        // opposite: our reason says nothing, so Meta's message is all the agent has.
        throw new BadRequestException(
          isKnownSendError(parsed.code, parsed.subcode)
            ? rule.reason
            : describeSendError(parsed, rule),
        );
      }
      throw new BadRequestException(`WhatsApp API error: ${responseText.slice(0, 300)}`);
    }
    try {
      return (JSON.parse(responseText)?.messages?.[0]?.id as string | undefined) ?? null;
    } catch {
      return null;
    }
  }
}
