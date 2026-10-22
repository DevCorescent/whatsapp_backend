import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@lib/prisma';
import { ChatbotController } from './chatbot.controller';
import { ChatbotService } from './chatbot.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { AiService } from '../ai/ai.service';

@Module({
  imports:     [PrismaModule, ConfigModule],
  controllers: [ChatbotController],
  providers:   [ChatbotService, KnowledgeService, AiService],
})
export class ChatbotModule {}
