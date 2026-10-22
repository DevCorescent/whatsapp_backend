import { Injectable } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  async getOnboarding(scope: TenantScope) {
    const [settings, business, whatsapp, teamCount, campaignCount] = await Promise.all([
      this.prisma.tenantSettings.findUnique({ where: { tenantId: scope.tenantId } }),
      this.prisma.business.findFirst({ where: { id: scope.businessId, tenantId: scope.tenantId } }),
      this.prisma.whatsAppIntegration.findFirst({
        where: { businessId: scope.businessId, isActive: true },
      }),
      this.prisma.user.count({ where: { tenantId: scope.tenantId } }),
      this.prisma.campaign.count({ where: { businessId: scope.businessId } }),
    ]);

    const steps = {
      profile:       !!(business?.name),
      whatsapp:      !!whatsapp,
      team:          teamCount > 1,
      firstCampaign: campaignCount > 0,
    };

    return {
      completed: settings?.onboardingCompleted ?? false,
      steps,
    };
  }

  async completeOnboarding(scope: TenantScope) {
    await this.prisma.tenantSettings.upsert({
      where:  { tenantId: scope.tenantId },
      update: { onboardingCompleted: true },
      create: { tenantId: scope.tenantId, onboardingCompleted: true },
    });
    return { completed: true };
  }
}
