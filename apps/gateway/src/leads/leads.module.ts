import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  imports:     [PrismaModule],
  controllers: [LeadsController],
  providers:   [LeadsService],
})
export class LeadsModule {}
