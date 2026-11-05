import { Controller, Get, Param, Res, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '@lib/prisma';

/**
 * The tracked link a broadcast recipient actually taps.
 *
 * A URL button in WhatsApp opens the browser straight away, so Meta reports nothing back
 * — the only way to know a link was followed is to be the link. Each recipient gets
 * their own address here; following it records the click and forwards them on.
 *
 * Deliberately public and unauthenticated: the person tapping it is a customer in a
 * WhatsApp chat, not a user of this product. The id in the path is a cuid, which is
 * unguessable enough for what it protects — a redirect to a URL the business chose.
 *
 * Nothing here may fail the redirect. If the click cannot be recorded the person still
 * reaches the page, because losing one number from a report is a smaller harm than a
 * customer meeting an error after tapping a link they were sent.
 */
@ApiTags('click')
@Controller('r')
export class ClickController {
  private readonly logger = new Logger(ClickController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get(':id')
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Record a broadcast link click and redirect to its destination' })
  async follow(@Param('id') id: string, @Res() res: Response): Promise<void> {
    let target: string | null = null;

    try {
      const row = await this.prisma.campaignContact.findUnique({
        where:  { id },
        select: { id: true, campaignId: true, clickUrl: true, clickedAt: true },
      });
      target = row?.clickUrl ?? null;

      if (row && target) {
        // The campaign's clicked count means "people who clicked", not "clicks", so it
        // only moves the first time. The per-recipient count keeps the raw total.
        const first = row.clickedAt == null;
        await this.prisma.$transaction([
          this.prisma.campaignContact.update({
            where: { id: row.id },
            data:  { clickCount: { increment: 1 }, ...(first ? { clickedAt: new Date() } : {}) },
          }),
          ...(first
            ? [this.prisma.campaign.update({
                where: { id: row.campaignId },
                data:  { clickedCount: { increment: 1 } },
              })]
            : []),
        ]);
      }
    } catch (err) {
      this.logger.error(`Could not record click ${id}: ${(err as Error).message}`);
    }

    if (!target) {
      // An id that matches nothing, or a link with no destination stored. There is
      // nowhere to send them, and a redirect loop would be worse than saying so.
      res.status(404).send('This link has expired.');
      return;
    }
    res.redirect(302, target);
  }
}
