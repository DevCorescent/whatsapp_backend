import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { OnboardingService } from './onboarding.service';

@ApiTags('onboarding')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly svc: OnboardingService) {}

  @Get()
  @ApiOperation({ summary: 'Get onboarding status and step completion' })
  getOnboarding(@CurrentTenant() scope: TenantScope) {
    return this.svc.getOnboarding(scope);
  }

  @Post('complete')
  @ApiOperation({ summary: 'Mark onboarding as completed' })
  completeOnboarding(@CurrentTenant() scope: TenantScope) {
    return this.svc.completeOnboarding(scope);
  }
}
