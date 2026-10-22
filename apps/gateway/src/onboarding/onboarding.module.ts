import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({
  imports:     [PrismaModule],
  controllers: [OnboardingController],
  providers:   [OnboardingService],
})
export class OnboardingModule {}
