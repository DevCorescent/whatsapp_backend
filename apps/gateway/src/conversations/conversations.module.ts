import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { ConversationsController } from '../../../../apps/messaging/src/conversations/conversations.controller';
import { ConversationsService }    from '../../../../apps/messaging/src/conversations/conversations.service';

@Module({
  imports:     [PrismaModule],
  controllers: [ConversationsController],
  providers:   [ConversationsService],
})
export class ConversationsModule {}
