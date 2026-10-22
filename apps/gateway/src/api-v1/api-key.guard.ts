import {
  Injectable, CanActivate, ExecutionContext, UnauthorizedException,
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
      where: { apiKey },
    });
    if (!settings) throw new UnauthorizedException('Invalid API key');

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
