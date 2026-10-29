import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { HandoverController } from './handover.controller';
import { DepartmentsService } from './departments.service';
import { HandoverEscalationService } from './handover-escalation.service';

@Module({
  imports:     [PrismaModule],
  controllers: [HandoverController],
  providers:   [DepartmentsService, HandoverEscalationService],
})
export class HandoverApiModule {}
