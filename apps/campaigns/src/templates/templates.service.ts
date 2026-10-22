import {
  Injectable, NotFoundException, ConflictException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';
import { QUEUE_TEMPLATE_SYNC } from '@lib/queue';

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_TEMPLATE_SYNC) private readonly syncQueue: Queue,
  ) {}

  // ── List ───────────────────────────────────────────────────────────────────

  async findAll(scope: TenantScope, query: {
    page?: number; limit?: number; status?: string; category?: string; search?: string;
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

  async create(scope: TenantScope, data: {
    name: string; category: string; language?: string;
    headerType?: string; headerContent?: string;
    body: string; footer?: string; buttons?: unknown;
    variables?: string[]; headerVariables?: string[];
  }) {
    const existing = await this.prisma.messageTemplate.findUnique({
      where: { name_businessId: { name: data.name, businessId: scope.businessId } },
    });
    if (existing) throw new ConflictException('A template with this name already exists');

    return this.prisma.messageTemplate.create({
      data: {
        tenantId:        scope.tenantId,
        businessId:      scope.businessId,
        name:            data.name,
        category:        data.category,
        language:        data.language ?? 'en',
        headerType:      data.headerType,
        headerContent:   data.headerContent,
        body:            data.body,
        footer:          data.footer,
        buttons:         data.buttons as any,
        variables:       data.variables ?? [],
        headerVariables: data.headerVariables ?? [],
        status:          'PENDING',
      },
    });
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  async update(scope: TenantScope, id: string, data: {
    name?: string; category?: string; language?: string;
    headerType?: string; headerContent?: string;
    body?: string; footer?: string; buttons?: unknown;
    variables?: string[]; headerVariables?: string[];
  }) {
    await this.findOne(scope, id); // 404 guard
    return this.prisma.messageTemplate.update({
      where: { id },
      data:  {
        name:            data.name,
        category:        data.category,
        language:        data.language,
        headerType:      data.headerType,
        headerContent:   data.headerContent,
        body:            data.body,
        footer:          data.footer,
        buttons:         data.buttons as any,
        variables:       data.variables,
        headerVariables: data.headerVariables,
        status:          'PENDING',   // needs re-approval after edit
        waTemplateId:    undefined,   // reset WA id
      },
    });
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
        name:            `${template.name} (Copy)`,
        category:        template.category,
        language:        template.language,
        headerType:      template.headerType,
        headerContent:   template.headerContent,
        body:            template.body,
        footer:          template.footer,
        buttons:         template.buttons as any,
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

    const integration = await this.prisma.whatsAppIntegration.findFirst({
      where: { businessId: scope.businessId, isDefault: true, isActive: true },
    });
    if (!integration?.accessToken) {
      throw new NotFoundException('No active default WhatsApp integration found');
    }

    const version = process.env.WHATSAPP_API_VERSION ?? 'v20.0';
    const url = `https://graph.facebook.com/${version}/${integration.whatsappBusinessId}/message_templates?name=${encodeURIComponent(template.name)}`;

    const res  = await fetch(url, {
      headers: { Authorization: `Bearer ${integration.accessToken}` },
    });
    const json = await res.json() as any;

    const remote = json?.data?.[0];
    if (!remote) {
      return { updated: false, status: template.status };
    }

    const updated = await this.prisma.messageTemplate.update({
      where: { id },
      data:  {
        status:          remote.status ?? template.status,
        waTemplateId:    remote.id     ?? template.waTemplateId,
        rejectionReason: remote.rejected_reason ?? null,
        lastSyncedAt:    new Date(),
      },
    });
    return { updated: true, status: updated.status };
  }

  // ── Import all templates from Meta ─────────────────────────────────────────

  async importFromMeta(scope: TenantScope) {
    const integration = await this.prisma.whatsAppIntegration.findFirst({
      where: { businessId: scope.businessId, isDefault: true, isActive: true },
    });
    if (!integration?.accessToken) {
      throw new NotFoundException('No active default WhatsApp integration found');
    }

    const version = process.env.WHATSAPP_API_VERSION ?? 'v20.0';
    const url = `https://graph.facebook.com/${version}/${integration.whatsappBusinessId}/message_templates?limit=200`;

    const res  = await fetch(url, {
      headers: { Authorization: `Bearer ${integration.accessToken}` },
    });
    const json = await res.json() as any;

    const templates: any[] = json?.data ?? [];
    let imported = 0;

    for (const t of templates) {
      const bodyComponent    = t.components?.find((c: any) => c.type === 'BODY');
      const headerComponent  = t.components?.find((c: any) => c.type === 'HEADER');
      const footerComponent  = t.components?.find((c: any) => c.type === 'FOOTER');
      const buttonsComponent = t.components?.find((c: any) => c.type === 'BUTTONS');

      if (!bodyComponent?.text) continue;

      await this.prisma.messageTemplate.upsert({
        where:  { name_businessId: { name: t.name, businessId: scope.businessId } },
        create: {
          tenantId:        scope.tenantId,
          businessId:      scope.businessId,
          name:            t.name,
          category:        t.category,
          language:        t.language,
          headerType:      headerComponent?.format   ?? null,
          headerContent:   headerComponent?.text     ?? null,
          body:            bodyComponent.text,
          footer:          footerComponent?.text     ?? null,
          buttons:         buttonsComponent?.buttons ?? null,
          variables:       [],
          headerVariables: [],
          waTemplateId:    t.id,
          status:          t.status,
          lastSyncedAt:    new Date(),
        },
        update: {
          waTemplateId: t.id,
          status:       t.status,
          lastSyncedAt: new Date(),
        },
      });
      imported++;
    }

    return { imported };
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

    const apiKey   = integration.accessToken;
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
    return { handle: result.h };
  }
}
