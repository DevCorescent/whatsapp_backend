import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { SuppressionService } from './suppression.service';

@Global()
@Module({
  imports:   [PrismaModule],
  providers: [SuppressionService],
  exports:   [SuppressionService],
})
export class SuppressionModule {}
