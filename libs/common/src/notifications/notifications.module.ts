import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { NotificationsService } from './notifications.service';

@Global()
@Module({
  imports:   [PrismaModule],
  providers: [NotificationsService],
  exports:   [NotificationsService],
})
export class NotificationsCoreModule {}
