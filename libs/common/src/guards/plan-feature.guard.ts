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
  /** True once the paid period has run out, whatever the stored status still says. */
  lapsed: boolean;
  /** Set when the period has run out but the platform's grace period has not. */
  inGrace: boolean;
}

/** Statuses that mean the plan is not paid for, regardless of the period dates. */
const UNPAID_STATUSES = ['EXPIRED', 'PAST_DUE', 'CANCELLED'];

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

    // Within grace everything keeps working. The platform decides how long, because the
    // first thing most people do after lapsing is come back and pay, and locking them out
    // at the stroke of midnight loses the renewal rather than securing it.
    if (plan?.lapsed && plan.inGrace) return Boolean(plan.features[feature]);

    // Past grace, the paid features stop and nothing else: sign-in, the existing
    // conversations and the billing pages all keep working, because locking the account
    // outright hides the data someone needs in order to decide to pay. A separate code
    // lets the app say "renew" rather than "upgrade" — the plan is not too small, it has
    // simply run out.
    if (plan?.lapsed) {
      throw new ForbiddenException({
        success:  false,
        error:    'Your plan has ended. Renew it to use this again.',
        code:     'PLAN_EXPIRED',
        feature,
        planName: plan.displayName,
      });
    }

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

    const policy = await this.planEndPolicy();

    const sub = await this.prisma.subscription.findUnique({
      where:  { tenantId },
      select: {
        status: true,
        currentPeriodEnd: true,
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
          // The dates decide, not the stored status: nothing sweeps lapsed rows the
          // instant they lapse, so a subscription can still read ACTIVE days after its
          // period ended. Reading the date here means access is correct immediately.
          lapsed:
            UNPAID_STATUSES.includes(sub.status) ||
            (sub.currentPeriodEnd != null && sub.currentPeriodEnd.getTime() <= Date.now()),
          // AUTO_CHARGE has no recurring billing behind it yet, so it is treated as
          // grace rather than quietly letting an unpaid account run on indefinitely.
          inGrace:
            policy.behaviour !== 'BLOCK' &&
            sub.currentPeriodEnd != null &&
            Date.now() < sub.currentPeriodEnd.getTime() + policy.graceDays * 86_400_000,
          features: {
            aiEnabled: sub.plan.aiEnabled, ragEnabled: sub.plan.ragEnabled, whiteLabel: sub.plan.whiteLabel,
            advancedAi: sub.plan.advancedAi, allowExport: sub.plan.allowExport, callingEnabled: sub.plan.callingEnabled,
          },
        }
      : null;
    this.cache.set(tenantId, { plan, expiresAt: Date.now() + CACHE_TTL_MS });
    return plan;
  }

  /**
   * The platform's answer to a lapsed plan, cached alongside the plans.
   *
   * Read from the PLATFORM tenant rather than the one being checked: it is a rule about
   * the product, not a preference of the customer being refused.
   */
  private async planEndPolicy(): Promise<{ behaviour: string; graceDays: number }> {
    const platform = await this.prisma.tenant.findFirst({
      where:  { accountType: 'PLATFORM' },
      select: { settings: { select: { planEndBehaviour: true, planEndGraceDays: true } } },
    });
    return {
      behaviour: platform?.settings?.planEndBehaviour ?? 'GRACE',
      graceDays: platform?.settings?.planEndGraceDays ?? 7,
    };
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
