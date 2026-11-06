import {
  Injectable, Logger, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '@lib/prisma';
import {
  TenantScope, MessageRatesService, RedisService, classifySendError, requireFields,
  normalizePhone, decryptSecret,
} from '@lib/common';
import { QUEUE_CAMPAIGN_SEND, CampaignSendJob } from '@lib/queue';
import { CampaignProgressService } from './campaign-progress.service';

/**
 * Shared with the send worker: while this key is set, every queued job for the campaign
 * returns without sending. The campaign row is cached per worker for half an hour, so the
 * database status alone cannot stop a run quickly enough.
 */
const HALT_KEY = (campaignId: string) => `campaign:halted:${campaignId}`;

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_CAMPAIGN_SEND) private readonly sendQueue: Queue,
    private readonly progress: CampaignProgressService,
    private readonly rates: MessageRatesService,
    private readonly redis: RedisService,
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

  async getDetail(scope: TenantScope, id: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where:   { id, tenantId: scope.tenantId, businessId: scope.businessId },
      include: { template: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');

    const recipients = await this.prisma.campaignContact.findMany({
      where:   { campaignId: id },
      orderBy: { id: 'asc' },
      include: { contact: { select: { id: true, name: true, phone: true } } },
    });

    return { campaign, recipients };
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  async create(scope: TenantScope, data: any) {
    // Route to broadcast handler for any audience-based creation
    if (
      Array.isArray(data.numbers) || data.segmentId || data.all ||
      Array.isArray(data.contactIds) || Array.isArray(data.contactListIds)
    ) {
      requireFields(data, ['name', 'templateId']);
      return this.createBroadcast(scope, data);
    }

    // A draft with no audience yet still needs a name to be findable again.
    requireFields(data, ['name']);

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

  // ── Broadcast create ───────────────────────────────────────────────────────

  private async createBroadcast(scope: TenantScope, data: any) {
    const {
      name,
      templateId,
      bodyVarMapping    = [] as string[],
      urlButtonMapping  = [] as string[],
      numbers,
      segmentId,
      all               = false,
      contactIds,
      contactListIds,
      excludeContactIds = [] as string[],
      recipientFields   = {} as Record<string, Record<string, string>>,
      scheduledAt,
      headerMediaId,
      headerMediaUrl,
      whatsappIntegrationId: requestedIntegrationId,
      ttlSeconds,
      dryRun            = false,
    } = data;

    const integration = await this.prisma.whatsAppIntegration.findFirst({
      where: {
        ...(requestedIntegrationId
          ? { id: requestedIntegrationId }
          : {}),
        tenantId: scope.tenantId,
        businessId: scope.businessId,
        isActive: true,
      },
      orderBy: { isDefault: 'desc' },
      select: { id: true, whatsappBusinessId: true },
    });
    if (!integration?.whatsappBusinessId) {
      throw new BadRequestException('Select an active WhatsApp number with a connected business account');
    }

    const template = await this.prisma.messageTemplate.findFirst({
      where: { id: templateId, tenantId: scope.tenantId, businessId: scope.businessId },
      select: { status: true, category: true, wabaId: true },
    });
    if (!template || template.status !== 'APPROVED') {
      throw new BadRequestException('Choose an approved WhatsApp template');
    }
    if (template.wabaId !== integration.whatsappBusinessId) {
      throw new BadRequestException('This template does not belong to the selected WhatsApp number');
    }
    const whatsappIntegrationId = integration.id;

    // ── 1. Gather raw phone numbers ─────────────────────────────────────────
    let rawNumbers: string[] = [];

    if (Array.isArray(numbers) && numbers.length > 0) {
      rawNumbers = numbers;
    } else if (Array.isArray(contactIds) && contactIds.length > 0) {
      const contacts = await this.prisma.contact.findMany({
        where:  { id: { in: contactIds }, businessId: scope.businessId, tenantId: scope.tenantId },
        select: { phone: true },
      });
      rawNumbers = contacts.map(c => c.phone);
    } else if (Array.isArray(contactListIds) && contactListIds.length > 0) {
      // Hand-picked groups. A list that is not this department's is refused rather than
      // quietly contributing nobody, which would look like an empty list instead of the
      // wrong one being chosen.
      const lists = await this.prisma.contactList.findMany({
        where:  { id: { in: contactListIds }, tenantId: scope.tenantId, businessId: scope.businessId },
        select: { id: true },
      });
      if (lists.length !== new Set(contactListIds).size) {
        throw new BadRequestException('One of those contact lists does not exist here.');
      }
      const members = await this.prisma.contactListMember.findMany({
        where:  { listId: { in: contactListIds } },
        select: { contact: { select: { phone: true } } },
      });
      rawNumbers = members.map(m => m.contact.phone).filter(Boolean);
    } else if (segmentId || all) {
      // Segment rows hold dynamic filters evaluated by lib/segments.ts.
      // Without importing that evaluator here we fall back to all non-opted-out
      // contacts for the business; a proper implementation would resolve filters.
      const contacts = await this.prisma.contact.findMany({
        where:  { businessId: scope.businessId, tenantId: scope.tenantId, optedOut: false },
        select: { phone: true },
      });
      rawNumbers = contacts.map(c => c.phone);
    }

    const total = rawNumbers.length;

    // ── 2. Deduplicate ──────────────────────────────────────────────────────
    // Normalised first, because the same person can reach here spelled two ways — a
    // pasted "+91 98765 43210" and the contact's stored "919876543210". Comparing the raw
    // strings let both through, and the customer received the campaign twice.
    const seen = new Set<string>();
    const uniqueNumbers: string[] = [];
    let duplicates = 0;
    for (const raw of rawNumbers) {
      const num = normalizePhone(raw);
      if (!num) continue;
      if (seen.has(num)) { duplicates++; } else { seen.add(num); uniqueNumbers.push(num); }
    }

    // ── 3. Check exclusions in parallel ────────────────────────────────────
    const [blacklistEntries, optedOutContacts, existingContacts] = await Promise.all([
      this.prisma.blacklistEntry.findMany({
        where:  { phone: { in: uniqueNumbers }, OR: [{ tenantId: scope.tenantId }, { tenantId: null }] },
        select: { phone: true },
      }),
      this.prisma.contact.findMany({
        where:  { phone: { in: uniqueNumbers }, businessId: scope.businessId, optedOut: true },
        select: { phone: true, name: true },
      }),
      this.prisma.contact.findMany({
        where:  { phone: { in: uniqueNumbers }, businessId: scope.businessId },
        select: { phone: true, name: true, id: true },
      }),
    ]);

    const blacklistedPhones = new Set(blacklistEntries.map(b => b.phone));
    const optedOutPhones    = new Set(optedOutContacts.map(c => c.phone));
    const contactMap        = new Map(existingContacts.map(c => [c.phone, c]));

    // ── 4. Partition into valid / excluded ──────────────────────────────────
    const excluded: Array<{ phone: string; name: string | null; reason: 'blacklisted' | 'opted_out' | 'deleted' }> = [];
    const validNumbers: string[] = [];

    for (const phone of uniqueNumbers) {
      if (blacklistedPhones.has(phone)) {
        excluded.push({ phone, name: contactMap.get(phone)?.name ?? null, reason: 'blacklisted' });
      } else if (optedOutPhones.has(phone)) {
        excluded.push({ phone, name: contactMap.get(phone)?.name ?? null, reason: 'opted_out' });
      } else {
        validNumbers.push(phone);
      }
    }

    const excludedByReason = {
      blacklisted: excluded.filter(e => e.reason === 'blacklisted').length,
      opted_out:   excluded.filter(e => e.reason === 'opted_out').length,
      deleted:     excluded.filter(e => e.reason === 'deleted').length,
    };
    const excludedCount = excluded.length;
    const matched       = validNumbers.length;

    // ── 5. Dry-run: return preview + cost estimate ──────────────────────────
    if (dryRun) {
      const wallet = await this.prisma.wallet.findUnique({
        where: { tenantId: scope.tenantId },
        select: { balanceMinor: true },
      });

      // Quote the price this customer will actually be charged (own → reseller → platform).
      const unitPriceMinor = await this.rates.priceFor(scope.tenantId, template?.category);

      const samplePhone  = validNumbers[0] ?? null;
      const sampleFields = samplePhone ? (recipientFields[samplePhone] ?? {}) : {};
      const bodyParams   = (bodyVarMapping as string[]).map((val, i) =>
        sampleFields[`slot_${i + 1}`] ?? val ?? ''
      );

      const recipients = validNumbers.map(phone => ({
        contactId: contactMap.get(phone)?.id ?? null,
        phone,
        name: contactMap.get(phone)?.name ?? null,
      }));

      return {
        total,
        matched,
        duplicates,
        scheduledAt: scheduledAt ?? null,
        excludedCount,
        excludedByReason,
        excluded,
        recipients,
        sample: samplePhone ? { phone: samplePhone, bodyParams } : null,
        cost: {
          units:              matched,
          unitPriceMinor,
          estimatedCostMinor: matched * unitPriceMinor,
          balanceMinor:       Math.max(0, wallet?.balanceMinor ?? 0),
        },
      };
    }

    // ── 6. Apply excludeContactIds from review step ─────────────────────────
    const excludedContactIdSet = new Set<string>(excludeContactIds ?? []);
    const finalNumbers = validNumbers.filter(phone => {
      const cid = contactMap.get(phone)?.id;
      return !cid || !excludedContactIdSet.has(cid);
    });

    // ── 7. Create Campaign record ───────────────────────────────────────────
    const campaign = await this.prisma.campaign.create({
      data: {
        name,
        tenantId:              scope.tenantId,
        businessId:            scope.businessId,
        templateId,
        scheduledAt:           scheduledAt ? new Date(scheduledAt) : undefined,
        whatsappIntegrationId,
        status:                scheduledAt ? 'SCHEDULED' : 'DRAFT',
        totalCount:            finalNumbers.length,
        metadata: {
          bodyVarMapping,
          urlButtonMapping,
          headerMediaId,
          headerMediaUrl,
          ttlSeconds,
        } as any,
      },
    });

    // ── 7b. Refuse an audience the number cannot legally send to ────────────
    // Checked again at launch, because the allowance moves between building a campaign
    // and sending it. Checking here as well means the refusal lands while the audience
    // is still on screen and can be cut down, instead of after the work is done.
    const allowance = await this.tierAllowance(scope, whatsappIntegrationId);
    if (!allowance.unlimited && finalNumbers.length > (allowance.remaining ?? 0)) {
      throw new BadRequestException(
        `This number can message ${allowance.remaining} more people in the next 24 hours ` +
        `(tier ${allowance.tier} allows ${allowance.cap} a day, ${allowance.used} already used). ` +
        `This audience is ${finalNumbers.length}. Reduce it, or send the rest tomorrow.`,
      );
    }

    // ── 8. Create CampaignContact rows ──────────────────────────────────────
    if (finalNumbers.length > 0) {
      // Tracking only works when the template's URL button points at our redirect, since
      // WhatsApp fixes the base in the template and lets the campaign fill the suffix.
      // With a base configured we put the recipient's own id in that suffix and keep the
      // real destination here; without one the link is passed through untouched and
      // clicks simply go unmeasured, which is better than rewriting it to nowhere.
      const trackingBase = (process.env['TRACKING_BASE_URL'] ?? '').replace(/\/+$/, '');

      const contactRows = finalNumbers.map(phone => {
        const contact = contactMap.get(phone);
        const fields  = (recipientFields[phone] ?? {}) as Record<string, string>;
        const variables: Record<string, string> = {};
        (bodyVarMapping as string[]).forEach((val, i) => {
          variables[`${i + 1}`] = fields[`slot_${i + 1}`] ?? val ?? '';
        });
        (urlButtonMapping as string[]).forEach((val, i) => {
          variables[`url_${i + 1}`] = fields[`url_${i + 1}`] ?? val ?? '';
        });
        Object.assign(variables, fields);

        // Prisma would mint the id on insert, but the suffix has to be known now so the
        // recipient's link can carry it.
        const id = randomUUID();
        const destination = variables['url_1']?.trim() || null;
        const tracked = Boolean(trackingBase && destination);
        if (tracked) variables['url_1'] = id;

        return {
          id,
          campaignId: campaign.id,
          phone,
          contactId:  contact?.id ?? undefined,
          variables:  variables as any,
          clickUrl:   tracked ? destination : null,
          status:     'PENDING',
        };
      });

      await this.prisma.campaignContact.createMany({ data: contactRows, skipDuplicates: true });
    }

    // ── 9. Launch immediately if not scheduled ──────────────────────────────
    if (!scheduledAt) {
      await this.launch(scope, campaign.id);
    }

    return {
      campaignId:      campaign.id,
      total,
      scheduledAt:     scheduledAt ?? undefined,
      excludedCount,
      excludedByReason,
      excluded,
    };
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

  /**
   * Fills a campaign's recipients from hand-picked contact lists.
   *
   * The people are copied in as they stand now, rather than the campaign holding a
   * reference to the list. A broadcast is a thing that happened to a known set of
   * people: if someone is added to the list tomorrow they did not receive yesterday's
   * send, and the report has to keep saying so.
   *
   * Contacts with no phone number are skipped rather than failing the whole call, and
   * counted back so the screen can say how many were left out and why.
   */
  async addContactsFromLists(scope: TenantScope, campaignId: string, listIds: string[]) {
    await this.findOne(scope, campaignId);

    const ids = [...new Set((listIds ?? []).filter(Boolean))];
    if (!ids.length) throw new BadRequestException('listIds is required.');

    const lists = await this.prisma.contactList.findMany({
      where:  { id: { in: ids }, tenantId: scope.tenantId, businessId: scope.businessId },
      select: { id: true },
    });
    if (lists.length !== ids.length) {
      throw new BadRequestException('One of those contact lists does not exist here.');
    }

    const members = await this.prisma.contactListMember.findMany({
      where:  { listId: { in: ids } },
      select: { contact: { select: { id: true, phone: true } } },
    });

    // One person in two chosen lists is still one recipient.
    const byId = new Map(members.map((m) => [m.contact.id, m.contact]));
    const reachable = [...byId.values()].filter((c) => Boolean(c.phone?.trim()));
    const withoutPhone = byId.size - reachable.length;

    if (!reachable.length) {
      throw new BadRequestException('Nobody in those lists has a phone number to message.');
    }

    await this.prisma.campaignContact.createMany({
      data: reachable.map((c) => ({
        campaignId, phone: c.phone!, contactId: c.id, status: 'PENDING' as const,
      })),
      skipDuplicates: true,
    });

    const total = await this.prisma.campaignContact.count({ where: { campaignId } });
    await this.prisma.campaign.update({ where: { id: campaignId }, data: { totalCount: total } });

    return { added: reachable.length, withoutPhone, total };
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
  /**
   * What is left of this number's 24-hour sending allowance.
   *
   * WhatsApp caps how many people a number may start conversations with per rolling day,
   * by tier. The cap used to be checked only at launch, so a campaign built for five
   * thousand people on a 250 tier looked fine for as long as it sat in drafts and failed
   * the moment someone pressed send — usually the moment it mattered. Exposed here so
   * the figure can be shown while the audience is still being chosen.
   */
  async tierAllowance(scope: TenantScope, whatsappIntegrationId?: string) {
    const integration = whatsappIntegrationId
      ? await this.prisma.whatsAppIntegration.findFirst({
          where:  { id: whatsappIntegrationId, businessId: scope.businessId },
          select: { messagingTier: true },
        })
      : await this.prisma.whatsAppIntegration.findFirst({
          where:  { businessId: scope.businessId, isDefault: true, isActive: true },
          select: { messagingTier: true },
        });

    const tier = integration?.messagingTier ?? 1;
    const cap  = this.tierDailyCap(tier);
    // Tier 0 is Meta's unlimited tier, which the cap table reports as 0.
    if (cap <= 0) return { tier, cap: null, used: 0, remaining: null, unlimited: true };

    const used = await this.sent24h(scope.businessId);
    return { tier, cap, used, remaining: Math.max(0, cap - used), unlimited: false };
  }

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

    // Recipients were filtered when the campaign was built, but that may have been days
    // ago. Anyone who has opted out since is dropped here rather than being sent to and
    // refused, which is what damages a number's quality rating.
    const skipped = await this.dropSuppressedRecipients(scope.tenantId, id);

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

    // Nothing left to send: finish it now rather than leaving it running forever.
    if (!recipients.length) {
      await this.prisma.campaign.update({
        where: { id },
        data:  { status: 'COMPLETED', completedAt: new Date() },
      });
      void this.progress.emitNow(id);
      return { enqueued: 0, skipped };
    }

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
    void this.progress.emitNow(id);
    return { enqueued: jobs.length, skipped };
  }

  /**
   * Mark every pending recipient who must not be messaged as skipped, and say how many.
   *
   * A number lands on the suppression list when WhatsApp tells us the person stopped
   * marketing messages, by error 131050 on an earlier send or by the user_preferences
   * webhook. Either way, sending again is both pointless and harmful.
   */
  private async dropSuppressedRecipients(tenantId: string, campaignId: string): Promise<number> {
    const pending = await this.prisma.campaignContact.findMany({
      where:  { campaignId, status: 'PENDING' },
      select: { id: true, phone: true },
    });
    if (!pending.length) return 0;

    const blocked = await this.prisma.blacklistEntry.findMany({
      where:  { phone: { in: pending.map((p) => p.phone) }, OR: [{ tenantId }, { tenantId: null }] },
      select: { phone: true, source: true, reason: true },
    });
    if (!blocked.length) return 0;

    const byPhone = new Map(blocked.map((b) => [b.phone, b]));
    const toSkip = pending.filter((p) => byPhone.has(p.phone));
    if (!toSkip.length) return 0;

    await this.prisma.campaignContact.updateMany({
      where: { id: { in: toSkip.map((p) => p.id) } },
      data:  {
        status: 'FAILED',
        failedAt: new Date(),
        failedReason: 'Not sent: this number is on your do-not-contact list.',
      },
    });
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data:  { skippedCount: { increment: toSkip.length } },
    });

    this.logger.log(`Campaign ${campaignId}: skipped ${toSkip.length} suppressed recipient(s) at launch`);
    return toSkip.length;
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
    void this.progress.emitNow(id);
    await this.clearHalt(id);
    return { cancelled: true };
  }

  // ── Pause and resume ───────────────────────────────────────────────────────

  /** Stop sending but keep the pending recipients, so it can be picked up later. */
  async pause(scope: TenantScope, id: string, reason?: string) {
    const existing = await this.findOne(scope, id);
    if (!['RUNNING', 'PROCESSING'].includes(existing.status)) {
      throw new BadRequestException('Only a running campaign can be paused');
    }
    await this.prisma.campaign.update({
      where: { id },
      data:  { status: 'PAUSED', haltedAt: new Date(), haltReason: reason ?? 'Paused manually', haltErrorCode: null },
    });
    // Workers cache the campaign row for half an hour, so the flag is what stops them.
    await this.redis.client.set(HALT_KEY(id), reason ?? 'Paused manually', 'EX', 24 * 60 * 60).catch(() => {});
    void this.progress.emitNow(id);
    return { paused: true };
  }

  /**
   * Send to whoever is still pending.
   *
   * A campaign that WhatsApp paused — a restricted account, a disabled template — will
   * halt again within a message or two unless the cause was fixed. That is the right
   * behaviour: it is cheaper than a long rejected run, and the reason is recorded each
   * time so it is clear nothing changed.
   */
  async resume(scope: TenantScope, id: string) {
    const existing = await this.findOne(scope, id);
    if (existing.status !== 'PAUSED') {
      throw new BadRequestException('Only a paused campaign can be resumed');
    }

    const pending = await this.prisma.campaignContact.findMany({
      where:  { campaignId: id, status: 'PENDING' },
      select: { id: true },
    });
    if (!pending.length) {
      throw new BadRequestException('Every recipient of this campaign has already been handled');
    }

    await this.clearHalt(id);
    await this.prisma.campaign.update({
      where: { id },
      data:  { status: 'RUNNING', haltedAt: null, haltReason: null, haltErrorCode: null },
    });

    await this.sendQueue.addBulk(pending.map((r) => ({
      data: {
        tenantId:    scope.tenantId,
        businessId:  scope.businessId,
        campaignId:  id,
        recipientId: r.id,
      } satisfies CampaignSendJob,
      opts: { attempts: 3, backoff: { type: 'exponential' as const, delay: 5000 } },
    })));

    void this.progress.emitNow(id);
    return { resumed: true, enqueued: pending.length };
  }

  /** Why a campaign stopped, and what it ran into, for the campaign screen. */
  async getFailureBreakdown(scope: TenantScope, id: string) {
    const campaign = await this.findOne(scope, id);

    const grouped = await this.prisma.campaignContact.groupBy({
      by:      ['errorCode'],
      where:   { campaignId: id, status: 'FAILED' },
      _count:  { _all: true },
    });

    // One recipient per code carries the explanation already written for it.
    const samples = await Promise.all(
      grouped.map((g) => this.prisma.campaignContact.findFirst({
        where:  { campaignId: id, status: 'FAILED', errorCode: g.errorCode },
        select: { failedReason: true, errorTitle: true },
      })),
    );

    return {
      status:        campaign.status,
      haltedAt:      campaign.haltedAt,
      haltReason:    campaign.haltReason,
      haltErrorCode: campaign.haltErrorCode,
      skippedCount:  campaign.skippedCount,
      failedCount:   campaign.failedCount,
      reasons: grouped
        .map((g, i) => ({
          errorCode: g.errorCode,
          title:     samples[i]?.errorTitle ?? null,
          reason:    samples[i]?.failedReason ?? 'No reason recorded.',
          count:     g._count._all,
          action:    classifySendError(g.errorCode).action,
        }))
        .sort((a, b) => b.count - a.count),
    };
  }

  private async clearHalt(id: string): Promise<void> {
    await this.redis.client.del(HALT_KEY(id)).catch(() => {});
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

  async uploadCampaignMedia(
    scope: TenantScope,
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
    templateId?: string,
  ) {
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

    // Meta scopes a media id to the phone number it was uploaded to, so this has to be
    // the number the campaign will send from or the send fails on a media id Meta does
    // not recognise. The template names that number; without one, the default is the
    // same choice campaign creation makes.
    const wabaId = templateId
      ? (await this.prisma.messageTemplate.findFirst({
          where:  { id: templateId, tenantId: scope.tenantId, businessId: scope.businessId },
          select: { wabaId: true },
        }))?.wabaId ?? null
      : null;

    const integration = await this.prisma.whatsAppIntegration.findFirst({
      where: {
        businessId: scope.businessId, tenantId: scope.tenantId, isActive: true,
        ...(wabaId ? { whatsappBusinessId: wabaId } : {}),
      },
      orderBy: { isDefault: 'desc' },
      select:  { phoneNumberId: true, accessToken: true, displayName: true },
    });
    if (!integration?.phoneNumberId || !integration.accessToken) {
      throw new BadRequestException('WhatsApp is not connected for this workspace');
    }

    // Tokens are stored encrypted. This sent the stored value straight to Meta, so every
    // upload went out as `Bearer enc:v1:…` and came back 401 — which surfaced as "something
    // went wrong on our side" and made the upload box look broken for no stated reason.
    const accessToken = decryptSecret(integration.accessToken);
    if (!accessToken) {
      throw new BadRequestException(
        `The access token for ${integration.displayName ?? 'this number'} could not be read. Reconnect it in Settings.`,
      );
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
        headers: { Authorization: `Bearer ${accessToken}` },
        body:    form,
      },
    );
    if (!res.ok) {
      const err: any = await res.json().catch(() => ({}));
      const why = err?.error?.message ?? `Meta returned ${res.status}`;
      this.logger.error(`Media upload rejected for ${integration.displayName}: ${why}`);
      // Meta's own sentence, not a generic failure — an expired token and a file it
      // refuses need different things done about them.
      throw new BadRequestException(`WhatsApp refused the upload: ${why}`);
    }
    const result: any = await res.json();
    return { mediaId: result.id, mimeType: file.mimetype };
  }
}
