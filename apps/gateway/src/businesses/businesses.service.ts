import {
  Injectable, NotFoundException, ForbiddenException, ConflictException,
} from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

@Injectable()
export class BusinessesService {
  constructor(private readonly prisma: PrismaService) {}

  private toSlug(name: string): string {
    return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  }

  // ── List ───────────────────────────────────────────────────────────────────

  async list(scope: TenantScope) {
    const rows = await this.prisma.business.findMany({
      where:   { tenantId: scope.tenantId },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { whatsappIntegrations: true } } },
    });

    const data = rows.map(({ whatsappAccessToken, whatsappVerifyToken, whatsappAppSecret, _count, ...rest }) => ({
      ...rest,
      hasWhatsappToken:      Boolean(whatsappAccessToken),
      hasWhatsappVerifyToken: Boolean(whatsappVerifyToken),
      hasWhatsappAppSecret:  Boolean(whatsappAppSecret),
      whatsappConnected:     (_count.whatsappIntegrations > 0) || Boolean(whatsappAccessToken),
      whatsappNumberCount:   _count.whatsappIntegrations,
    }));

    // Wrap with success + currentBusinessId so TransformInterceptor passes through unchanged
    return { success: true, data, currentBusinessId: scope.businessId };
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  async create(scope: TenantScope, data: { name: string }) {
    // Check plan limit
    const subscription = await this.prisma.subscription.findUnique({
      where:   { tenantId: scope.tenantId },
      include: { plan: { select: { maxBusinesses: true } } },
    });

    if (subscription?.plan?.maxBusinesses != null) {
      const current = await this.prisma.business.count({
        where: { tenantId: scope.tenantId, status: { not: 'INACTIVE' } },
      });
      if (current >= subscription.plan.maxBusinesses) {
        throw new ForbiddenException(
          `Plan limit reached: max ${subscription.plan.maxBusinesses} businesses allowed`,
        );
      }
    }

    const slug = this.toSlug(data.name);

    return this.prisma.business.create({
      data: {
        tenantId: scope.tenantId,
        name:     data.name,
        slug,
        status:   'ACTIVE',
      },
    });
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  async update(
    scope: TenantScope,
    id: string,
    data: { name?: string; logo?: string; timezone?: string; status?: string },
  ) {
    const existing = await this.prisma.business.findFirst({
      where: { id, tenantId: scope.tenantId },
    });
    if (!existing) throw new NotFoundException('Business not found');

    return this.prisma.business.update({
      where: { id },
      data:  {
        ...(data.name     !== undefined && { name:     data.name }),
        ...(data.logo     !== undefined && { logo:     data.logo }),
        ...(data.timezone !== undefined && { timezone: data.timezone }),
        ...(data.status   !== undefined && { status:   data.status as any }),
      },
    });
  }

  // ── Delete (soft) ──────────────────────────────────────────────────────────

  async remove(scope: TenantScope, id: string) {
    const existing = await this.prisma.business.findFirst({
      where: { id, tenantId: scope.tenantId },
    });
    if (!existing) throw new NotFoundException('Business not found');

    const activeCount = await this.prisma.business.count({
      where: { tenantId: scope.tenantId, status: { not: 'INACTIVE' } },
    });
    if (activeCount <= 1) {
      throw new ForbiddenException('Cannot delete the last active business');
    }

    return this.prisma.business.update({
      where: { id },
      data:  { status: 'INACTIVE' },
    });
  }

  // ── Switch ─────────────────────────────────────────────────────────────────

  async switchBusiness(scope: TenantScope, businessId: string) {
    const business = await this.prisma.business.findFirst({
      where: { id: businessId, tenantId: scope.tenantId, status: 'ACTIVE' },
    });
    if (!business) throw new NotFoundException('Business not found or inactive');

    return { business, switchTo: business.id };
  }
}
