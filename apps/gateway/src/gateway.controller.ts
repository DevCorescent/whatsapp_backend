import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@lib/common';
import { GatewayService } from './gateway.service';

@Controller()
export class GatewayController {
  constructor(private readonly svc: GatewayService) {}

  @Get('ping')
  ping() {
    return { status: 'ok', ts: new Date().toISOString() };
  }

  /** White-label brand config for a given host (public — used by login/sign-up pages). */
  @Get('brand')
  brandByHost(@Query('host') host?: string) {
    return this.svc.getBrandForHost(host);
  }

  /** White-label brand config for a tenant (public — used by email templates). */
  @Get('brand/by-tenant')
  brandByTenant(@Query('tenantId') tenantId: string) {
    return this.svc.getBrandForTenant(tenantId);
  }

  /** Subscription plan display name for the sidebar badge. */
  @Get('account/plan-name')
  @UseGuards(JwtAuthGuard)
  planName(@Request() req: any) {
    return this.svc.getPlanName(req.user.tenantId);
  }

  /** Public CMS sections for the marketing site (no auth required). */
  @Get('cms/sections/public')
  getPublicCmsSections() {
    return this.svc.getPublicCmsSections();
  }
}
