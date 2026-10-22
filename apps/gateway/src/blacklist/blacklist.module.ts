import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { BlacklistController } from './blacklist.controller';
import { BlacklistService } from './blacklist.service';

@Module({
  imports:     [PrismaModule],
  controllers: [BlacklistController],
  providers:   [BlacklistService],
})
export class BlacklistModule {}
