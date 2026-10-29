import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { QUEUE_CALLS } from '@lib/queue';
import { CallsService } from './calls.service';
import type { CallTimeoutJob } from './calls-webhook.service';

/** Safety net: if Meta's terminate webhook never arrives, a ringing call still ends as missed. */
@Processor(QUEUE_CALLS)
export class CallTimeoutProcessor {
  constructor(private readonly calls: CallsService) {}

  @Process('timeout')
  async handle(job: Job<CallTimeoutJob>) {
    await this.calls.markMissed(job.data.callId);
  }
}
