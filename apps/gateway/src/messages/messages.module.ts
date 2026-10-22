import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { MessagesController } from './messages.controller';
import { ConversationsService } from '../../../../apps/messaging/src/conversations/conversations.service';

@Module({
  imports:     [PrismaModule],
  controllers: [MessagesController],
  providers:   [ConversationsService],
})
export class MessagesModule {}
