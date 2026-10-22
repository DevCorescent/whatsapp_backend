import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '@lib/prisma';
import { QUEUE_TEMPLATE_SYNC } from '@lib/queue';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';
import { TemplateSyncProcessor } from '../processors/template-sync.processor';

@Module({
  imports:     [PrismaModule, BullModule.registerQueue({ name: QUEUE_TEMPLATE_SYNC })],
  controllers: [TemplatesController],
  providers:   [TemplatesService, TemplateSyncProcessor],
})
export class TemplatesModule {}
