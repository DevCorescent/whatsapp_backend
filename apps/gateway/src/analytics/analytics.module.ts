import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { NumberActivityService } from './number-activity.service';

@Module({
  imports:     [PrismaModule],
  controllers: [AnalyticsController],
  providers:   [AnalyticsService, NumberActivityService],
  exports:     [AnalyticsService],
})
export class AnalyticsModule {}
