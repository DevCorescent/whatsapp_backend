import {
  Injectable, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';
import { QUEUE_CAMPAIGN_SEND, CampaignSendJob } from '@lib/queue';

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_CAMPAIGN_SEND) private readonly sendQueue: Queue,
  ) {}

  // ── List ───────────────────────────────────────────────────────────────────

  async findAll(scope: TenantScope, query: { page?: number; limit?: number; status?: string }) {
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const skip  = (page - 1) * limit;

    const where: any = { tenantId: scope.tenantId, businessId: scope.businessId };
    if (query.status) where.status = query.status;

    const [campaigns, total] = await Promise.all([
      this.prisma.campaign.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
        include: { template: { select: { id: true, name: true, category: true } } },
      }),
      this.prisma.campaign.count({ where }),
    ]);

    return { campaigns, total, page, limit };
  }

  // ── List scheduled ─────────────────────────────────────────────────────────

  async listScheduled(scope: TenantScope) {
    return this.prisma.campaign.findMany({
      where: {
        tenantId:    scope.tenantId,
        businessId:  scope.businessId,
        status:      'SCHEDULED',
        scheduledAt: { gt: new Date() },
      },
      orderBy: { scheduledAt: 'asc' },
      include: { template: { select: { id: true, name: true, category: true } } },
    });
  }

  // ── Get one ────────────────────────────────────────────────────────────────

  async findOne(scope: TenantScope, id: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where:   { id, tenantId: scope.tenantId, businessId: scope.businessId },
      include: {
        template: true,
        contacts: { take: 5, orderBy: { sentAt: 'desc' } },
      },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  async create(scope: TenantScope, data: {
    name: string; templateId?: string; scheduledAt?: string;
    whatsappIntegrationId?: string; filters?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }) {
    return this.prisma.campaign.create({
      data: {
        name:                  data.name,
        tenantId:              scope.tenantId,
        businessId:            scope.businessId,
        templateId:            data.templateId,
        scheduledAt:           data.scheduledAt ? new Date(data.scheduledAt) : undefined,
        whatsappIntegrationId: data.whatsappIntegrationId,
        filters:               data.filters as any,
        metadata:              data.metadata as any,
        status:                'DRAFT',
      },
    });
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  async update(scope: TenantScope, id: string, data: {
    name?: string; templateId?: string; scheduledAt?: string | null;
    whatsappIntegrationId?: string; filters?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }) {
    const existing = await this.findOne(scope, id);
    if (!['DRAFT', 'SCHEDULED'].includes(existing.status)) {
      throw new BadRequestException('Only DRAFT or SCHEDULED campaigns can be updated');
    }
    return this.prisma.campaign.update({
      where: { id },
      data:  {
        name:                  data.name,
        templateId:            data.templateId,
        scheduledAt:           data.scheduledAt === null ? null
                             : data.scheduledAt ? new Date(data.scheduledAt) : undefined,
        whatsappIntegrationId: data.whatsappIntegrationId,
        filters:               data.filters as any,
        metadata:              data.metadata as any,
      },
    });
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async remove(scope: TenantScope, id: string) {
    const existing = await this.findOne(scope, id);
    if (!['DRAFT', 'SCHEDULED', 'CANCELLED'].includes(existing.status)) {
      throw new BadRequestException('Only DRAFT, SCHEDULED or CANCELLED campaigns can be deleted');
    }
    await this.prisma.campaign.delete({ where: { id } });
    return { deleted: true };
  }

  // ── Add recipients ─────────────────────────────────────────────────────────

  async addContacts(scope: TenantScope, campaignId: string, contacts: Array<{
    phone: string; contactId?: string; variables?: Record<string, string>;
  }>) {
    await this.findOne(scope, campaignId);

    const data = contacts.map(c => ({
      campaignId,
      phone:     c.phone,
      contactId: c.contactId,
      variables: c.variables as any,
      status:    'PENDING',
    }));

    await this.prisma.campaignContact.createMany({ data, skipDuplicates: true });
    const count = await this.prisma.campaignContact.count({ where: { campaignId } });
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data:  { totalCount: count },
    });
    return { added: contacts.length, total: count };
  }

  // ── Duplicate ──────────────────────────────────────────────────────────────

  async duplicate(scope: TenantScope, id: string) {
    const campaign = await this.findOne(scope, id);

    const newCampaign = await this.prisma.campaign.create({
      data: {
        tenantId:              campaign.tenantId,
        businessId:            campaign.businessId,
        name:                  `${campaign.name} (Copy)`,
        templateId:            campaign.templateId,
        whatsappIntegrationId: campaign.whatsappIntegrationId,
        filters:               campaign.filters as any,
        metadata:              campaign.metadata as any,
        status:                'DRAFT',
        scheduledAt:           null,
        startedAt:             null,
        completedAt:           null,
        totalCount:            0,
        sentCount:             0,
        deliveredCount:        0,
        readCount:             0,
        repliedCount:          0,
        clickedCount:          0,
        failedCount:           0,
        costMinor:             0,
      },
    });

    // Copy CampaignContact rows, resetting per-message tracking
    const existingContacts = await this.prisma.campaignContact.findMany({
      where: { campaignId: id },
    });

    if (existingContacts.length) {
      await this.prisma.campaignContact.createMany({
        data: existingContacts.map(c => ({
          campaignId: newCampaign.id,
          contactId:  c.contactId,
          phone:      c.phone,
          variables:  c.variables as any,
          status:     'PENDING',
        })),
        skipDuplicates: true,
      });
      await this.prisma.campaign.update({
        where: { id: newCampaign.id },
        data:  { totalCount: existingContacts.length },
      });
    }

    return this.findOne(scope, newCampaign.id);
  }

  // ── Tier limits ────────────────────────────────────────────────────────────

  /** Returns the daily send cap for a messaging tier (0 = unlimited). */
  private tierDailyCap(tier: number): number {
    const caps: Record<number, number> = { 1: 250, 2: 2000, 3: 10000, 4: 100000 };
    return caps[tier] ?? 0;
  }

  /** Count outbound campaign messages sent from this business in the last 24 hours. */
  private async sent24h(businessId: string): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return this.prisma.campaignContact.count({
      where: {
        campaign:  { businessId },
        sentAt:    { gte: since },
        status:    { in: ['SENT', 'DELIVERED', 'READ', 'REPLIED'] },
      },
    });
  }

  // ── Launch ─────────────────────────────────────────────────────────────────

  async launch(scope: TenantScope, id: string) {
    const campaign = await this.findOne(scope, id);
    if (!['DRAFT', 'SCHEDULED'].includes(campaign.status)) {
      throw new BadRequestException('Campaign must be DRAFT or SCHEDULED to launch');
    }
    if (!campaign.templateId) {
      throw new BadRequestException('Campaign must have a template before launching');
    }

    // ── Tier limit check ──────────────────────────────────────────────────────
    const integration = campaign.whatsappIntegrationId
      ? await this.prisma.whatsAppIntegration.findUnique({
          where:  { id: campaign.whatsappIntegrationId },
          select: { messagingTier: true },
        })
      : await this.prisma.whatsAppIntegration.findFirst({
          where:  { businessId: scope.businessId, isDefault: true, isActive: true },
          select: { messagingTier: true },
        });

    const cap = this.tierDailyCap(integration?.messagingTier ?? 1);
    if (cap > 0) {
      const [alreadySent, recipientCount] = await Promise.all([
        this.sent24h(scope.businessId),
        this.prisma.campaignContact.count({ where: { campaignId: id, status: 'PENDING' } }),
      ]);
      const remaining = cap - alreadySent;
      if (remaining <= 0) {
        throw new BadRequestException(
          `Daily messaging limit reached (${cap} messages). Your tier resets after 24 hours.`
        );
      }
      if (recipientCount > remaining) {
        throw new BadRequestException(
          `Campaign has ${recipientCount} recipients but only ${remaining} messages remain in your 24-hour tier limit (${cap} total). Reduce recipients or upgrade your tier.`
        );
      }
    }

    // Set to RUNNING
    await this.prisma.campaign.update({
      where: { id },
      data:  { status: 'RUNNING', startedAt: new Date() },
    });

    // Enqueue all PENDING recipients
    const recipients = await this.prisma.campaignContact.findMany({
      where: { campaignId: id, status: 'PENDING' },
      select: { id: true },
    });

    const jobs = recipients.map(r => ({
      data: {
        tenantId:    scope.tenantId,
        businessId:  scope.businessId,
        campaignId:  id,
        recipientId: r.id,
      } satisfies CampaignSendJob,
      opts: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    }));

    if (jobs.length) await this.sendQueue.addBulk(jobs);
    return { enqueued: jobs.length };
  }

  // ── Cancel ─────────────────────────────────────────────────────────────────

  async cancel(scope: TenantScope, id: string) {
    const existing = await this.findOne(scope, id);
    if (!['DRAFT', 'SCHEDULED', 'RUNNING'].includes(existing.status)) {
      throw new BadRequestException('Campaign cannot be cancelled in its current state');
    }
    await this.prisma.campaign.update({
      where: { id },
      data:  { status: 'CANCELLED' },
    });
    // Mark all pending recipients as cancelled
    await this.prisma.campaignContact.updateMany({
      where:  { campaignId: id, status: 'PENDING' },
      data:   { status: 'CANCELLED' },
    });
    return { cancelled: true };
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getStats(scope: TenantScope, id: string) {
    const campaign = await this.findOne(scope, id);
    return {
      id:             campaign.id,
      status:         campaign.status,
      totalCount:     campaign.totalCount,
      sentCount:      campaign.sentCount,
      deliveredCount: campaign.deliveredCount,
      readCount:      campaign.readCount,
      repliedCount:   campaign.repliedCount,
      failedCount:    campaign.failedCount,
      clickedCount:   campaign.clickedCount,
      costMinor:      campaign.costMinor,
    };
  }

  // ── Upload media to Meta ────────────────────────────────────────────────────

  async uploadCampaignMedia(scope: TenantScope, file: { buffer: Buffer; mimetype: string; originalname: string; size: number }) {
    if (!file) throw new BadRequestException('No file provided');

    const ALLOWED = new Set([
      'image/jpeg', 'image/png', 'image/webp',
      'video/mp4', 'video/3gpp',
      'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ]);
    if (!ALLOWED.has(file.mimetype)) {
      throw new BadRequestException(`File type "${file.mimetype}" is not allowed.`);
    }
    if (file.size > 16 * 1024 * 1024) {
      throw new BadRequestException('File is too large. Maximum size is 16 MB.');
    }

    const integration = await this.prisma.whatsAppIntegration.findFirst({
      where:  { businessId: scope.businessId, tenantId: scope.tenantId, isActive: true },
      select: { phoneNumberId: true, accessToken: true },
    });
    if (!integration?.phoneNumberId || !integration.accessToken) {
      throw new Error('WhatsApp is not connected for this workspace');
    }

    const apiVer = process.env.WHATSAPP_API_VERSION ?? 'v20.0';
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', file.mimetype);
    form.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.originalname);

    const res = await fetch(
      `https://graph.facebook.com/${apiVer}/${integration.phoneNumberId}/media`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${integration.accessToken}` },
        body:    form,
      },
    );
    if (!res.ok) {
      const err: any = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message ?? 'Upload failed');
    }
    const result: any = await res.json();
    return { mediaId: result.id, mimeType: file.mimetype };
  }
}
