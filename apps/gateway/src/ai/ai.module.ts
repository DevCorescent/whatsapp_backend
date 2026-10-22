import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@lib/prisma';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

@Module({
  imports:     [PrismaModule, ConfigModule],
  controllers: [AiController],
  providers:   [AiService],
  exports:     [AiService],
})
export class AiModule {}
