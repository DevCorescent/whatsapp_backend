import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { QuickRepliesController } from './quick-replies.controller';
import { QuickRepliesService } from './quick-replies.service';

@Module({
  imports:     [PrismaModule],
  controllers: [QuickRepliesController],
  providers:   [QuickRepliesService],
})
export class QuickRepliesModule {}
