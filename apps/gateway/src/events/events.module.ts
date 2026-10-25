import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisPubSubService } from '@lib/common';
import { EventsController } from './events.controller';

@Module({
  imports:     [ConfigModule],
  controllers: [EventsController],
  providers:   [RedisPubSubService],
})
export class EventsModule {}
