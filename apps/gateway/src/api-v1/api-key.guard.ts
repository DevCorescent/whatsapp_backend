import {
  Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '@lib/prisma';

export interface ApiKeyContext {
  tenantId:   string;
  businessId: string;
  userId:     string;
  role:       string;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req    = ctx.switchToHttp().getRequest();
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (!apiKey) throw new UnauthorizedException('Missing X-Api-Key header');

    const settings = await this.prisma.tenantSettings.findUnique({
      where:   { apiKey },
      include: {
        tenant: {
          include: {
            subscriptions: {
              where:   { status: { in: ['ACTIVE', 'TRIALING'] } },
              include: { plan: { select: { features: true } } },
              take:    1,
            },
          },
        },
      },
    });
    if (!settings) throw new UnauthorizedException('Invalid API key');

    // Plan-gating: plan must include 'api_access' feature
    const planFeatures: string[] = settings.tenant?.subscriptions?.[0]?.plan?.features ?? [];
    if (!planFeatures.includes('api_access')) {
      throw new ForbiddenException('API access is not enabled on your current plan. Please upgrade.');
    }

    // Resolve default business for this tenant
    const business = await this.prisma.business.findFirst({
      where: { tenantId: settings.tenantId },
    });
    if (!business) throw new UnauthorizedException('No business found for this tenant');

    // Attach scope to request (same shape as JWT scope)
    req.user = {
      tenantId:   settings.tenantId,
      businessId: business.id,
      userId:     'api',
      role:       'API',
    } satisfies ApiKeyContext;

    return true;
  }
}
