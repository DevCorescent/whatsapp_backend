import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@lib/prisma';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { AiService } from '../ai/ai.service';

@Module({
  imports:     [PrismaModule, ConfigModule],
  controllers: [KnowledgeController],
  providers:   [KnowledgeService, AiService],
})
export class KnowledgeModule {}
