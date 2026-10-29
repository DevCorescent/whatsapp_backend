import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '@lib/prisma';
import { PlanFeatureGuard } from '@lib/common';
import { QUEUE_CALLS } from '@lib/queue';
import { CallsController }      from '../../../../apps/messaging/src/calls/calls.controller';
import { CallsService }         from '../../../../apps/messaging/src/calls/calls.service';
import { MetaCallsClient }      from '../../../../apps/messaging/src/calls/meta-calls.client';
import { CallTimeoutProcessor } from '../../../../apps/messaging/src/calls/call-timeout.processor';

@Module({
  imports:     [PrismaModule, ConfigModule, BullModule.registerQueue({ name: QUEUE_CALLS })],
  controllers: [CallsController],
  providers:   [CallsService, MetaCallsClient, CallTimeoutProcessor, PlanFeatureGuard],
  exports:     [CallsService, MetaCallsClient],
})
export class CallsModule {}
