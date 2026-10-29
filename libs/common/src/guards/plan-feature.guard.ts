import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '@lib/prisma';

export type PlanFeatureKey = 'aiEnabled' | 'ragEnabled' | 'whiteLabel' | 'advancedAi' | 'allowExport' | 'callingEnabled';

const PLAN_FEATURE_KEY = 'planFeature';
const CACHE_TTL_MS = 60_000;

/** Refuse the route unless the tenant's plan switches this feature on. Use after JwtAuthGuard. */
export const RequiresPlanFeature = (feature: PlanFeatureKey) => SetMetadata(PLAN_FEATURE_KEY, feature);

interface PlanSnapshot {
  name: string;
  displayName: string;
  features: Record<PlanFeatureKey, boolean>;
}

/**
 * Loads Subscription → Plan once a minute per tenant and answers 403 in the
 * `featureErrorBody` wire shape (lib/billing/limits.ts) so the UpgradeModal
 * handles it like every other plan refusal.
 */
@Injectable()
export class PlanFeatureGuard implements CanActivate {
  private readonly cache = new Map<string, { plan: PlanSnapshot | null; expiresAt: number }>();

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma:    PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<PlanFeatureKey | undefined>(PLAN_FEATURE_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (!feature) return true;

    const req = ctx.switchToHttp().getRequest();
    const tenantId: string | undefined = req.user?.tenantId;
    if (!tenantId) throw new ForbiddenException('No tenant');

    const plan = await this.planFor(tenantId);
    if (plan?.features[feature]) return true;

    throw new ForbiddenException({
      success:  false,
      error:    `${FEATURE_LABEL[feature]} is not included in your plan.`,
      code:     'PLAN_FEATURE',
      feature,
      planName: plan?.displayName ?? 'your plan',
    });
  }

  async planFor(tenantId: string): Promise<PlanSnapshot | null> {
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.plan;

    const sub = await this.prisma.subscription.findUnique({
      where:  { tenantId },
      select: {
        plan: {
          select: {
            name: true, displayName: true, aiEnabled: true, ragEnabled: true, whiteLabel: true,
            advancedAi: true, allowExport: true, callingEnabled: true,
          },
        },
      },
    });
    const plan: PlanSnapshot | null = sub?.plan
      ? {
          name: sub.plan.name, displayName: sub.plan.displayName,
          features: {
            aiEnabled: sub.plan.aiEnabled, ragEnabled: sub.plan.ragEnabled, whiteLabel: sub.plan.whiteLabel,
            advancedAi: sub.plan.advancedAi, allowExport: sub.plan.allowExport, callingEnabled: sub.plan.callingEnabled,
          },
        }
      : null;
    this.cache.set(tenantId, { plan, expiresAt: Date.now() + CACHE_TTL_MS });
    return plan;
  }

  invalidate(tenantId: string) {
    this.cache.delete(tenantId);
  }
}

const FEATURE_LABEL: Record<PlanFeatureKey, string> = {
  aiEnabled:      'AI auto-reply',
  ragEnabled:     'Knowledge base (RAG)',
  whiteLabel:     'White label',
  advancedAi:     'Advanced AI (lead scoring)',
  allowExport:    'CSV export',
  callingEnabled: 'WhatsApp calling',
};
