import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '@lib/prisma';
import { RedisService } from '../redis/redis.service';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';
import { MessageEventsService } from './message-events.service';

@Global()
@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      imports:    [ConfigModule],
      inject:     [ConfigService],
      useFactory: (cfg: ConfigService) => ({ secret: cfg.getOrThrow<string>('JWT_SECRET') }),
    }),
  ],
  providers: [RedisService, RealtimeGateway, RealtimeService, MessageEventsService],
  exports:   [RedisService, RealtimeService, MessageEventsService],
})
export class RealtimeModule {}
