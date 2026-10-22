import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports:     [PrismaModule],
  controllers: [TicketsController],
  providers:   [TicketsService],
})
export class TicketsModule {}
