import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { SegmentsController } from './segments.controller';
import { SegmentsService } from './segments.service';

@Module({
  imports:     [PrismaModule],
  controllers: [SegmentsController],
  providers:   [SegmentsService],
})
export class SegmentsModule {}
