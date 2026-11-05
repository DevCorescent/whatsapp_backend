import {
  Injectable, NotFoundException, ConflictException, Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '@lib/prisma';
import {
  TenantScope, decryptSecret, parseMetaTemplate, pickTemplateAccount, toSpec, validateTemplate,
  StorageService, requireFields,} from '@lib/common';
import { QUEUE_TEMPLATE_SYNC } from '@lib/queue';

/** What the builder may write. `status`, `waTemplateId` and the sync stamps are ours. */
export interface TemplateWriteInput {
  name?: string;
  category?: string;
  language?: string;
  templateType?: string;
  parameterFormat?: string;
  headerType?: string | null;
  headerContent?: string | null;
  headerVariables?: string[];
  body?: string;
  variables?: string[];
  footer?: string | null;
  buttons?: unknown;
  cards?: unknown;
  ltoText?: string | null;
  ltoHasExpiration?: boolean;
  addSecurityRecommendation?: boolean;
  codeExpirationMinutes?: number | null;
  messageSendTtlSeconds?: number | null;
  /** The WhatsApp account to submit it to, when the builder picked a number. */
  wabaId?: string | null;
}

/**
 * The fields create and update both write, with `undefined` left out so a PATCH that
 * omits a field keeps it. Only an explicit `null` clears one.
 */
function writableFields(data: TemplateWriteInput) {
  return {
    templateType:    data.templateType,
    parameterFormat: data.parameterFormat,
    headerType:      data.headerType,
    headerContent:   data.headerContent,
    footer:          data.footer,
    buttons:         data.buttons as any,
    cards:           data.cards as any,
    ltoText:         data.ltoText,
    ltoHasExpiration: data.ltoHasExpiration,
    addSecurityRecommendation: data.addSecurityRecommendation,
    codeExpirationMinutes:     data.codeExpirationMinutes,
    messageSendTtlSeconds:     data.messageSendTtlSeconds,
    wabaId:                    data.wabaId,
  };
}

@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @InjectQueue(QUEUE_TEMPLATE_SYNC) private readonly syncQueue: Queue,
  ) {}

  // ── List ───────────────────────────────────────────────────────────────────

  async findAll(scope: TenantScope, query: {
    page?: number; limit?: number; status?: string; category?: string; search?: string;
    whatsappIntegrationId?: string;
  }) {
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const skip  = (page - 1) * limit;

    const where: any = { tenantId: scope.tenantId, businessId: scope.businessId };
    if (query.status)   where.status   = query.status;
    if (query.category) where.category = query.category;
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }

    // Templates belong to a WhatsApp account, and a number can only send its own.
    if (query.whatsappIntegrationId) {
      const integration = await this.prisma.whatsAppIntegration.findFirst({
        where:  {
          id: query.whatsappIntegrationId,
          tenantId: scope.tenantId,
          businessId: scope.businessId,
          isActive: true,
        },
        select: { whatsappBusinessId: true },
      });
      if (integration?.whatsappBusinessId) {
        where.wabaId = integration.whatsappBusinessId;
      } else {
        // A missing, inactive, or unconfigured integration must never fall back to
        // showing every account's templates.
        where.id = { in: [] };
      }
    }

    const [templates, total] = await Promise.all([
      this.prisma.messageTemplate.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      this.prisma.messageTemplate.count({ where }),
    ]);
    return { templates, total, page, limit };
  }

  // ── Get one ────────────────────────────────────────────────────────────────

  async findOne(scope: TenantScope, id: string) {
    const t = await this.prisma.messageTemplate.findFirst({
      where: { id, tenantId: scope.tenantId, businessId: scope.businessId },
    });
    if (!t) throw new NotFoundException('Template not found');
    return t;
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  async create(scope: TenantScope, data: TemplateWriteInput) {
    // Meta refuses a template missing any of these, several seconds later and in its own
    // words. Saying so here means the author fixes the form instead of reading a Graph
    // API error about a submission that never had a chance.
    requireFields(data as Record<string, unknown>, ['name', 'category', 'body']);

    const existing = await this.prisma.messageTemplate.findUnique({
      where: { name_businessId: { name: data.name!, businessId: scope.businessId } },
    });
    if (existing) throw new ConflictException('A template with this name already exists');

    return this.prisma.messageTemplate.create({
      data: {
        tenantId:   scope.tenantId,
        businessId: scope.businessId,
        name:       data.name!,
        category:   data.category!,
        language:   data.language ?? 'en',
        body:       data.body ?? '',
        ...writableFields(data),
        variables:       data.variables ?? [],
        headerVariables: data.headerVariables ?? [],
        status:          'PENDING',
      },
    });
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  async update(scope: TenantScope, id: string, data: TemplateWriteInput) {
    await this.findOne(scope, id); // 404 guard
    return this.prisma.messageTemplate.update({
      where: { id },
      data:  {
        name:            data.name,
        category:        data.category,
        language:        data.language,
        body:            data.body,
        ...writableFields(data),
        variables:       data.variables,
        headerVariables: data.headerVariables,
        status:          'PENDING',   // needs re-approval after edit
        waTemplateId:    undefined,   // reset WA id
      },
    });
  }

  // ── Check a draft without submitting it ────────────────────────────────────

  /** Everything Meta would reject, so the builder can show it before submission. */
  async validate(scope: TenantScope, id: string) {
    const template = await this.findOne(scope, id);
    const errors = validateTemplate(toSpec(template));
    return { valid: errors.length === 0, errors };
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async remove(scope: TenantScope, id: string) {
    await this.findOne(scope, id);
    await this.prisma.messageTemplate.delete({ where: { id } });
    return { deleted: true };
  }

  // ── Submit to Meta (enqueue template-sync job) ────────────────────────────

  async submitToMeta(scope: TenantScope, id: string) {
    await this.findOne(scope, id);
    await this.syncQueue.add({ tenantId: scope.tenantId, businessId: scope.businessId, templateId: id });
    await this.prisma.messageTemplate.update({
      where: { id },
      data:  { status: 'PENDING' },
    });
    return { queued: true };
  }

  // ── Duplicate ──────────────────────────────────────────────────────────────

  async duplicate(scope: TenantScope, id: string) {
    const template = await this.findOne(scope, id);

    return this.prisma.messageTemplate.create({
      data: {
        tenantId:        template.tenantId,
        businessId:      template.businessId,
        // Meta requires lowercase alphanumerics and underscores, so no " (Copy)".
        name:            `${template.name}_copy`,
        category:        template.category,
        language:        template.language,
        templateType:    template.templateType,
        parameterFormat: template.parameterFormat,
        headerType:      template.headerType,
        headerContent:   template.headerContent,
        body:            template.body,
        footer:          template.footer,
        buttons:         template.buttons as any,
        cards:           template.cards as any,
        ltoText:         template.ltoText,
        ltoHasExpiration: template.ltoHasExpiration,
        addSecurityRecommendation: template.addSecurityRecommendation,
        codeExpirationMinutes:     template.codeExpirationMinutes,
        messageSendTtlSeconds:     template.messageSendTtlSeconds,
        wabaId:          template.wabaId,
        variables:       template.variables,
        headerVariables: template.headerVariables,
        status:          'PENDING',
        waTemplateId:    null,
        lastSyncedAt:    null,
      },
    });
  }

  // ── Refresh status from Meta ───────────────────────────────────────────────

  async refreshStatus(scope: TenantScope, id: string) {
    const template = await this.findOne(scope, id);

    // Meta scopes templates to one account, so a status has to be read from the account
    // the template actually lives in.
    const integration = pickTemplateAccount(
      await this.prisma.whatsAppIntegration.findMany({
        where: { businessId: scope.businessId, isActive: true },
      }),
      template.wabaId,
    );
    if (!integration?.accessToken) {
      throw new NotFoundException(
        template.wabaId
          ? "This template's WhatsApp account is no longer connected"
          : 'No active WhatsApp integration found',
      );
    }

    const accessToken = decryptSecret(integration.accessToken);
    if (!accessToken) throw new NotFoundException('Could not decrypt WhatsApp access token');

    const version = process.env.WHATSAPP_API_VERSION ?? 'v20.0';
    const url = `https://graph.facebook.com/${version}/${integration.whatsappBusinessId}/message_templates?name=${encodeURIComponent(template.name)}`;
    this.logger.log(`refreshStatus → GET ${url} (tokenPrefix=${accessToken.slice(0, 8)}...)`);

    const res  = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = await res.json() as any;
    this.logger.log(`refreshStatus ← status=${res.status} data=${JSON.stringify(json?.data?.[0]?.status ?? json?.error)}`);

    const remote = json?.data?.[0];
    if (!remote) {
      // A draft that was never submitted is simply not there yet. One that has a Meta id
      // and is now absent was deleted in WhatsApp Manager, and saying it is still
      // approved would offer a template every send fails on.
      if (!res.ok || !template.waTemplateId) return { updated: false, status: template.status };
      const gone = await this.prisma.messageTemplate.update({
        where: { id },
        data:  {
          status:          'DISABLED',
          rejectionReason: 'This template no longer exists in WhatsApp Manager.',
          lastSyncedAt:    new Date(),
        },
      });
      return { updated: true, status: gone.status };
    }

    const updated = await this.prisma.messageTemplate.update({
      where: { id },
      data:  {
        status:          remote.status ?? template.status,
        waTemplateId:    remote.id     ?? template.waTemplateId,
        // Found in this account, so record it if it was unknown.
        wabaId:          template.wabaId ?? integration.whatsappBusinessId,
        rejectionReason: remote.rejection_reason ?? null,
        lastSyncedAt:    new Date(),
      },
    });
    return { updated: true, status: updated.status };
  }

  // ── Import all templates from Meta ─────────────────────────────────────────

  /**
   * Pulls every template from every WhatsApp account the workspace has connected.
   *
   * Each account is read with its own token, and every row records the account it came
   * from, so a number is only ever offered templates it can actually send.
   */
  async importFromMeta(scope: TenantScope) {
    const integrations = (await this.prisma.whatsAppIntegration.findMany({
      where:   { businessId: scope.businessId, isActive: true },
      orderBy: { isDefault: 'desc' },
    })).filter((i) => i.whatsappBusinessId && i.accessToken);

    if (!integrations.length) {
      throw new NotFoundException('No active WhatsApp integration found');
    }

    // Keep the local cards: Meta returns each card's upload handle but not the public
    // media URL we send with, so a re-import would otherwise strip it. The account is
    // kept too, because a template name is unique per workspace while two accounts may
    // each hold one — the first account to claim a name keeps it.
    const existing = new Map(
      (await this.prisma.messageTemplate.findMany({
        where:  { businessId: scope.businessId },
        select: { name: true, cards: true, wabaId: true },
      })).map((t) => [t.name, t]),
    );

    let created = 0;
    let updated = 0;
    const seen = new Set<string>();
    const failed: string[] = [];

    for (const integration of integrations) {
      try {
        const counts = await this.importAccount(scope, integration, existing, seen);
        created += counts.created;
        updated += counts.updated;
      } catch (err: any) {
        // One unreachable account must not lose the templates of the others.
        this.logger.error(`importFromMeta failed for ${integration.whatsappBusinessId}: ${err.message}`);
        failed.push(integration.displayName ?? integration.phoneNumber ?? 'a number');
      }
    }

    if (failed.length === integrations.length) {
      throw new NotFoundException(`Couldn't reach WhatsApp for ${failed.join(', ')}`);
    }

    // A template that once synced but is in none of the accounts was deleted in WhatsApp
    // Manager. Leaving it approved offers a template every send would fail on. Only safe
    // when every account answered, or templates of an unread account would be condemned.
    let retired = 0;
    if (!failed.length) {
      const gone = await this.prisma.messageTemplate.updateMany({
        where: {
          businessId: scope.businessId,
          name:       { notIn: [...seen] },
          status:     { in: ['APPROVED', 'PENDING', 'PAUSED'] },
          NOT:        { waTemplateId: null },
        },
        data: {
          status:          'DISABLED',
          rejectionReason: 'This template no longer exists in WhatsApp Manager.',
        },
      });
      retired = gone.count;
      if (retired) this.logger.log(`importFromMeta retired ${retired} template(s) Meta no longer has`);
    }

    return {
      success: true, created, updated,
      ...(retired ? { retired } : {}),
      ...(failed.length ? { failed } : {}),
    };
  }

  /**
   * One account's templates. `existing` is read and updated across accounts, and every
   * name Meta returned is added to `seen` — including ones skipped here, since they do
   * exist at Meta.
   */
  private async importAccount(
    scope: TenantScope,
    integration: { whatsappBusinessId: string | null; accessToken: string | null },
    existing: Map<string, { name: string; cards: unknown; wabaId: string | null }>,
    seen: Set<string>,
  ) {
    const accessToken = decryptSecret(integration.accessToken ?? '');
    if (!accessToken) throw new NotFoundException('Could not decrypt WhatsApp access token');
    this.logger.log(`importFromMeta businessId=${scope.businessId} wabaId=${integration.whatsappBusinessId} tokenPrefix=${accessToken.slice(0, 8)}...`);

    const version = process.env.WHATSAPP_API_VERSION ?? 'v20.0';
    let nextUrl: string | null =
      `https://graph.facebook.com/${version}/${integration.whatsappBusinessId}/message_templates?limit=200`;

    let created = 0;
    let updated = 0;

    while (nextUrl) {
      this.logger.log(`importFromMeta → GET ${nextUrl}`);
      const res  = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const json = await res.json() as any;
      this.logger.log(`importFromMeta ← status=${res.status} count=${json?.data?.length ?? 0} hasNext=${!!json?.paging?.next} error=${JSON.stringify(json?.error ?? null)}`);
      // An expired token or a revoked account answers here, and silently importing
      // nothing would look like success.
      if (!res.ok) throw new Error(json?.error?.message ?? `Meta returned ${res.status}`);

      const templates: any[] = json?.data ?? [];

      for (const t of templates) {
        seen.add(t.name);

        const parsed = parseMetaTemplate(t);
        // An authentication template has no body text of its own — Meta writes it.
        if (!parsed.body && parsed.category?.toUpperCase() !== 'AUTHENTICATION') continue;

        const previous = existing.get(t.name);
        // A name already held by another account can't be stored twice, and overwriting
        // would move the row — and every campaign pointing at it — to this account.
        if (previous?.wabaId && previous.wabaId !== integration.whatsappBusinessId) {
          this.logger.warn(`Skipping "${t.name}": the name is already used by account ${previous.wabaId}`);
          continue;
        }

        const previousCards: any[] = Array.isArray(previous?.cards) ? previous.cards as any[] : [];
        const cards = parsed.cards?.map((card, i) => ({
          ...card,
          headerUrl: card.headerUrl ?? previousCards[i]?.headerUrl ?? null,
        })) ?? null;

        await this.prisma.messageTemplate.upsert({
          where:  { name_businessId: { name: t.name, businessId: scope.businessId } },
          create: {
            tenantId:        scope.tenantId,
            businessId:      scope.businessId,
            name:            t.name,
            category:        parsed.category ?? t.category,
            language:        parsed.language ?? t.language,
            templateType:    parsed.templateType ?? 'STANDARD',
            parameterFormat: parsed.parameterFormat ?? 'POSITIONAL',
            headerType:      parsed.headerType ?? null,
            headerContent:   parsed.headerContent ?? null,
            headerVariables: parsed.headerVariables ?? [],
            body:            parsed.body,
            variables:       parsed.variables ?? [],
            footer:          parsed.footer ?? null,
            buttons:         (parsed.buttons ?? []) as any,
            cards:           (cards ?? undefined) as any,
            ltoText:         parsed.ltoText ?? null,
            ltoHasExpiration: parsed.ltoHasExpiration ?? false,
            addSecurityRecommendation: parsed.addSecurityRecommendation ?? false,
            codeExpirationMinutes:     parsed.codeExpirationMinutes ?? null,
            messageSendTtlSeconds:     parsed.messageSendTtlSeconds ?? null,
            wabaId:          integration.whatsappBusinessId,
            waTemplateId:    t.id,
            status:          t.status,
            lastSyncedAt:    new Date(),
          },
          // Meta is the source of truth for an imported template, so refresh its
          // content too — a template edited in Business Manager must not drift here.
          update: {
            category:        parsed.category ?? t.category,
            templateType:    parsed.templateType ?? 'STANDARD',
            parameterFormat: parsed.parameterFormat ?? 'POSITIONAL',
            headerType:      parsed.headerType ?? null,
            headerContent:   parsed.headerContent ?? null,
            headerVariables: parsed.headerVariables ?? [],
            body:            parsed.body,
            variables:       parsed.variables ?? [],
            footer:          parsed.footer ?? null,
            buttons:         (parsed.buttons ?? []) as any,
            cards:           (cards ?? null) as any,
            ltoText:         parsed.ltoText ?? null,
            ltoHasExpiration: parsed.ltoHasExpiration ?? false,
            addSecurityRecommendation: parsed.addSecurityRecommendation ?? false,
            codeExpirationMinutes:     parsed.codeExpirationMinutes ?? null,
            messageSendTtlSeconds:     parsed.messageSendTtlSeconds ?? null,
            wabaId:       integration.whatsappBusinessId,
            waTemplateId: t.id,
            status:       t.status,
            lastSyncedAt: new Date(),
          },
        });

        if (previous) updated++; else created++;
        existing.set(t.name, {
          name: t.name, cards: cards ?? null, wabaId: integration.whatsappBusinessId,
        });
      }

      nextUrl = json?.paging?.next ?? null;
    }

    return { created, updated };
  }

  // ── Sync all pending templates ─────────────────────────────────────────────

  async syncAll(scope: TenantScope) {
    const templates = await this.prisma.messageTemplate.findMany({
      where: { businessId: scope.businessId, status: 'PENDING', waTemplateId: null },
    });

    for (const t of templates) {
      await this.syncQueue.add({
        tenantId:   scope.tenantId,
        businessId: scope.businessId,
        templateId: t.id,
      });
    }

    return { enqueued: templates.length };
  }

  // ── Upload header media ─────────────────────────────────────────────────────

  /**
   * One upload, two results. Meta approves a template against a resumable-upload
   * **handle**, but sending a message needs a media id or a public **URL** — a handle is
   * no good there. So the bytes also go to our own bucket when one is configured, and the
   * caller gets a URL it can send with. Without a bucket the URL is null and the builder
   * asks for one.
   */
  async uploadHeaderMedia(scope: TenantScope, file: { buffer: Buffer; mimetype: string; originalname: string; size: number }) {
    if (!file) throw new Error('No file provided');

    const ALLOWED = new Set([
      'image/jpeg', 'image/png', 'image/webp',
      'video/mp4', 'video/3gpp',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]);
    if (!ALLOWED.has(file.mimetype)) {
      throw new Error(`File type "${file.mimetype}" is not supported for template headers.`);
    }
    if (file.size > 4 * 1024 * 1024) {
      throw new Error('File is too large — maximum 4 MB for template header samples.');
    }

    const integration = await this.prisma.whatsAppIntegration.findFirst({
      where:  { businessId: scope.businessId, tenantId: scope.tenantId, isActive: true },
      select: { accessToken: true },
    });
    if (!integration?.accessToken) throw new Error('WhatsApp is not connected for this workspace');

    const apiKey = decryptSecret(integration.accessToken);
    if (!apiKey) throw new Error('WhatsApp access token could not be decrypted');
    const apiVer   = process.env.WHATSAPP_API_VERSION ?? 'v20.0';
    const filename = file.originalname ?? `header.${file.mimetype.split('/')[1]}`;

    // Step 1: create upload session
    const sessionRes = await fetch(
      `https://graph.facebook.com/${apiVer}/app/uploads?file_length=${file.size}&file_type=${encodeURIComponent(file.mimetype)}&access_token=${apiKey}`,
      { method: 'POST' },
    );
    if (!sessionRes.ok) {
      const err: any = await sessionRes.json().catch(() => ({}));
      throw new Error(err?.error?.message ?? 'Failed to create upload session');
    }
    const { id: uploadId } = await sessionRes.json() as { id: string };

    // Step 2: upload file bytes
    const uploadRes = await fetch(`https://graph.facebook.com/${apiVer}/${uploadId}`, {
      method:  'POST',
      headers: {
        Authorization:   `OAuth ${apiKey}`,
        file_offset:     '0',
        'Content-Type':  file.mimetype,
      },
      body: new Uint8Array(file.buffer) as unknown as BodyInit,
    });
    if (!uploadRes.ok) {
      const err: any = await uploadRes.json().catch(() => ({}));
      throw new Error(err?.error?.message ?? 'Upload failed');
    }
    const result: any = await uploadRes.json();

    // Step 3: keep a copy we can send with. Optional — the handle alone is enough to
    // get the template approved.
    let url: string | null = null;
    if (this.storage.isConfigured()) {
      try {
        const key = this.storage.mediaKey({
          tenantId:   scope.tenantId,
          businessId: scope.businessId,
          id:         `templates/${Date.now()}`,
          mimeType:   file.mimetype,
          filename,
        });
        url = (await this.storage.put(key, file.buffer, file.mimetype)).url;
      } catch (err) {
        this.logger.warn(`Template media stored at Meta but not in our bucket: ${(err as Error).message}`);
      }
    }

    return { handle: result.h, url };
  }
}
