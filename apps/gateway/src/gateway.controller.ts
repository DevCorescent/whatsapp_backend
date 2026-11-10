import { Controller, Get, HttpStatus, Query, Request, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '@lib/common';
import { GatewayService } from './gateway.service';

@Controller()
export class GatewayController {
  constructor(private readonly svc: GatewayService) {}

  @Get('ping')
  ping() {
    return { status: 'ok', ts: new Date().toISOString() };
  }

  /**
   * Answers the reverse proxy's "may I get a certificate for this host?".
   *
   * 200 means yes, 404 means no — the contract Caddy's `on_demand_tls.ask` expects. It is
   * what keeps a single machine from obtaining a certificate for any hostname someone
   * chooses to point at it.
   */
  @Get('hosting/domain-allowed')
  async domainAllowed(@Query('domain') domain: string, @Res() res: Response) {
    const ok = await this.svc.isDomainAllowed(domain);
    res.status(ok ? HttpStatus.OK : HttpStatus.NOT_FOUND).send(ok ? 'ok' : 'no');
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
  getPublicCmsSections(@Query('host') host?: string) {
    return this.svc.getPublicCmsSections(host);
  }
}
