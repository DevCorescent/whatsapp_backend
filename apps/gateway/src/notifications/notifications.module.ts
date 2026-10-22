import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { NotificationsController } from './notifications.controller';

@Module({
  imports:     [PrismaModule],
  controllers: [NotificationsController],
})
export class NotificationsModule {}
