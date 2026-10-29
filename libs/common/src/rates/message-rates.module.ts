import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { MessageRatesService } from './message-rates.service';

@Global()
@Module({
  imports:   [PrismaModule],
  providers: [MessageRatesService],
  exports:   [MessageRatesService],
})
export class MessageRatesModule {}
