import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';

@Module({
  imports:     [PrismaModule],
  controllers: [ExportController],
  providers:   [ExportService],
})
export class ExportModule {}
