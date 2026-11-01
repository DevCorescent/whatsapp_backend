import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { MailService } from './mail.service';

/** Global, because almost anything that changes a person's access may need to say so. */
@Global()
@Module({
  imports:   [PrismaModule],
  providers: [MailService],
  exports:   [MailService],
})
export class MailModule {}
