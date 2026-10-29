import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { HandoverService } from './handover.service';
import { LeadQualificationService } from '../leads/lead-qualification.service';

/**
 * The two things the AI hands off: a conversation to a colleague, and a conversation's
 * worth as a lead. They travel together because both are triggered from the same place in
 * the inbound pipeline and both read the same conversation.
 */
@Global()
@Module({
  imports:   [PrismaModule],
  providers: [HandoverService, LeadQualificationService],
  exports:   [HandoverService, LeadQualificationService],
})
export class HandoverModule {}
