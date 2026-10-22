import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { NewsletterController } from './newsletter.controller';
import { NewsletterService } from './newsletter.service';

@Module({
  imports:     [PrismaModule],
  controllers: [NewsletterController],
  providers:   [NewsletterService],
})
export class NewsletterModule {}
