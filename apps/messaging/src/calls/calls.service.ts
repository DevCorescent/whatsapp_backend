import {
  BadRequestException, ConflictException, GoneException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@lib/prisma';
import {
  TenantScope, RealtimeService, RedisService, MessageEventsService, NotificationsService, AGENT_ROLES, decryptSecret,
  StorageService,
} from '@lib/common';
import { MetaCallsClient, MetaCallError } from './meta-calls.client';

export const OFFER_TTL_SEC = 120;
/** Meta gives roughly 30–60 s to answer; we stop ringing in the UI at 60 s. */
export const RING_TIMEOUT_MS = 60_000;

const GOOGLE_STUN = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun3.l.google.com:19302',
  'stun:stun4.l.google.com:19302',
];

type CallStatusValue = 'RINGING' | 'CONNECTING' | 'IN_PROGRESS' | 'COMPLETED' | 'MISSED' | 'REJECTED' | 'FAILED';

const CALL_LABEL: Record<CallStatusValue, string> = {
  RINGING: 'Incoming call', CONNECTING: 'Connecting call', IN_PROGRESS: 'Call in progress',
  COMPLETED: 'Voice call', MISSED: 'Missed call', REJECTED: 'Call declined', FAILED: 'Call failed',
};

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    private readonly prisma:        PrismaService,
    private readonly redis:         RedisService,
    private readonly realtime:      RealtimeService,
    private readonly events:        MessageEventsService,
    private readonly notifications: NotificationsService,
    private readonly meta:          MetaCallsClient,
    private readonly cfg:           ConfigService,
    private readonly storage:       StorageService,
  ) {}

  offerKey(waCallId: string) {
    return `call:offer:${waCallId}`;
  }

  /** STUN from Google always; TURN only when configured (TURN_URLS[,TURN_USERNAME,TURN_CREDENTIAL]). */
  iceServers(): RTCIceServerLike[] {
    const servers: RTCIceServerLike[] = [{ urls: GOOGLE_STUN }];
    const turn = (this.cfg.get<string>('TURN_URLS') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (turn.length) {
      servers.push({
        urls: turn,
        username:   this.cfg.get<string>('TURN_USERNAME') || undefined,
        credential: this.cfg.get<string>('TURN_CREDENTIAL') || undefined,
      });
    }
    return servers;
  }

  // ── Agent actions ───────────────────────────────────────────────────────────

  /**
   * Places a call to a contact.
   *
   * Three things have to be true and each fails differently, so each is checked and
   * named rather than collapsed into one refusal: calling must be switched on for the
   * number, the contact must exist in this department, and Meta must agree the customer
   * can be called — which depends on them having messaged recently or having granted
   * permission, and is the one we cannot know in advance.
   */
  async initiate(scope: TenantScope, body: { contactId: string; sdpOffer: string; integrationId?: string }) {
    if (!body.sdpOffer?.includes('a=')) throw new BadRequestException('A WebRTC SDP offer is required');

    const contact = await this.prisma.contact.findFirst({
      where:  { id: body.contactId, tenantId: scope.tenantId, businessId: scope.businessId },
      select: { id: true, phone: true, name: true },
    });
    if (!contact) throw new NotFoundException('That contact is not in this department');

    const integration = body.integrationId
      ? await this.prisma.whatsAppIntegration.findFirst({
          where: { id: body.integrationId, businessId: scope.businessId, isActive: true },
        })
      : await this.prisma.whatsAppIntegration.findFirst({
          where: { businessId: scope.businessId, isActive: true, isDefault: true },
        });
    if (!integration) throw new BadRequestException('No active WhatsApp number to call from');

    if (!integration.callingEnabled) {
      // Actionable rather than merely true: the setting is ours to change, and saying
      // where turns a dead end into one more click.
      throw new BadRequestException(
        integration.callingFollowsBusinessHours
          ? "Calling is closed outside this department's business hours. Change the hours, or switch calling to always on, in Settings → WhatsApp numbers."
          : 'Calling is switched off for this number. Turn it on in Settings → WhatsApp numbers.',
      );
    }

    const accessToken = integration.accessToken ? decryptSecret(integration.accessToken) : null;
    if (!accessToken) throw new BadRequestException('This WhatsApp number has no usable access token');

    let callId: string;
    try {
      ({ callId } = await this.meta.connect(
        integration.phoneNumberId, accessToken, contact.phone, body.sdpOffer,
      ));
    } catch (err) {
      const why = err instanceof MetaCallError ? err.message : 'Could not place the call';
      throw new BadRequestException(why);
    }

    const conversation = await this.prisma.conversation.findFirst({
      where:  { contactId: contact.id, businessId: scope.businessId },
      select: { id: true },
      orderBy: { updatedAt: 'desc' },
    });

    const call = await this.prisma.call.create({
      data: {
        waCallId:              callId,
        tenantId:              scope.tenantId,
        businessId:            scope.businessId,
        whatsappIntegrationId: integration.id,
        contactId:             contact.id,
        conversationId:        conversation?.id ?? null,
        direction:             'OUTBOUND',
        status:                'RINGING',
        answeredById:          scope.userId,
        fromPhone:             integration.phoneNumber ?? integration.phoneNumberId,
        toPhone:               contact.phone,
      },
    });

    this.logger.log(`Outgoing call ${call.id} to ${contact.name ?? contact.phone}`);
    return call;
  }

  async accept(scope: TenantScope, callId: string, sdpAnswer: string) {
    if (!sdpAnswer?.includes('a=')) throw new BadRequestException('A WebRTC SDP answer is required');
    const call = await this.find(scope, callId);

    // First agent to claim wins; everyone else gets 409 and their ringing UI closes via call:status.
    const claimed = await this.prisma.call.updateMany({
      where: { id: call.id, status: 'RINGING' },
      data:  { status: 'CONNECTING', answeredById: scope.userId },
    });
    if (claimed.count === 0) throw new ConflictException('This call was already answered or has ended');

    const offer = await this.redis.client.get(this.offerKey(call.waCallId));
    if (!offer) {
      await this.transition(call.id, ['CONNECTING'], { status: 'MISSED', endedAt: new Date(), errorTitle: 'Offer expired before answering' });
      throw new GoneException('The call expired before it could be answered');
    }

    const { phoneNumberId, accessToken } = await this.credentials(call.whatsappIntegrationId);
    try {
      await this.meta.preAccept(phoneNumberId, accessToken, call.waCallId, sdpAnswer);
      await this.meta.accept(phoneNumberId, accessToken, call.waCallId, sdpAnswer, call.id);
    } catch (err) {
      const title = err instanceof MetaCallError ? err.message : 'Could not connect the call';
      await this.transition(call.id, ['CONNECTING'], { status: 'FAILED', endedAt: new Date(), errorTitle: title, errorCode: err instanceof MetaCallError ? err.code ?? null : null });
      throw new BadRequestException(title);
    }

    await this.transition(call.id, ['CONNECTING'], { status: 'IN_PROGRESS', answeredAt: new Date() });
    return { ok: true };
  }

  async reject(scope: TenantScope, callId: string) {
    const call = await this.find(scope, callId);
    const claimed = await this.prisma.call.updateMany({
      where: { id: call.id, status: 'RINGING' },
      data:  { status: 'REJECTED', answeredById: scope.userId, endedAt: new Date() },
    });
    if (claimed.count === 0) throw new ConflictException('This call is no longer ringing');
    await this.afterTransition(call.id);

    const { phoneNumberId, accessToken } = await this.credentials(call.whatsappIntegrationId);
    await this.meta.reject(phoneNumberId, accessToken, call.waCallId).catch(err =>
      this.logger.warn(`Meta reject failed for ${call.waCallId}: ${err?.message ?? err}`));
    return { ok: true };
  }

  /**
   * Ends a call on both sides.
   *
   * Meta's terminate used to be fire-and-forget: a refusal was logged and then ignored,
   * so our side went quiet and showed the call as over while the customer's phone was
   * still connected. The agent had no way to know, and the customer was left talking to
   * nobody — the worst version of this failing.
   *
   * It still ends locally when Meta refuses, because the agent has already gone and
   * pretending otherwise helps no one. But the refusal is now reported, and the call is
   * recorded with the reason rather than as a clean completion.
   */
  async hangup(scope: TenantScope, callId: string) {
    const call = await this.find(scope, callId);
    const { phoneNumberId, accessToken } = await this.credentials(call.whatsappIntegrationId);

    this.logger.log(`[hangup] call=${call.id} waCallId=${call.waCallId} status=${call.status} — terminating at Meta`);

    let metaError: string | null = null;
    try {
      await this.meta.terminate(phoneNumberId, accessToken, call.waCallId);
      this.logger.log(`[hangup] call=${call.id} Meta accepted the terminate`);
    } catch (err) {
      metaError = err instanceof MetaCallError ? err.message : ((err as Error)?.message ?? 'unknown error');
      this.logger.error(`[hangup] call=${call.id} Meta REFUSED the terminate: ${metaError}`);
    }

    const endedAt = new Date();
    const duration = call.answeredAt ? Math.max(0, Math.round((endedAt.getTime() - call.answeredAt.getTime()) / 1000)) : 0;
    await this.transition(call.id, ['CONNECTING', 'IN_PROGRESS'], {
      status: 'COMPLETED',
      endedAt,
      durationSec: duration,
      ...(metaError ? { errorTitle: `Hang-up not confirmed by WhatsApp: ${metaError}`.slice(0, 250) } : {}),
    });

    if (metaError) {
      throw new BadRequestException(
        `The call ended here, but WhatsApp did not confirm it: ${metaError}. ` +
        `The customer may still be connected — ask them to hang up.`,
      );
    }
    return { ok: true };
  }

  // ── Lifecycle helpers (also used by the webhook + timeout job) ──────────────

  /** Marks a still-ringing call missed; safe to call more than once. */
  async markMissed(callId: string, endedAt = new Date()) {
    const changed = await this.transition(callId, ['RINGING'], { status: 'MISSED', endedAt });
    if (!changed) return;

    const call = await this.prisma.call.findUnique({
      where: { id: callId },
      include: { contact: { select: { name: true, phone: true } }, conversation: { select: { assignedToId: true } } },
    });
    if (!call) return;
    await this.prisma.conversation.updateMany({
      where: { id: call.conversationId ?? '' },
      data:  { unreadCount: { increment: 1 }, lastMessageAt: endedAt, lastMessagePreview: '📞 Missed call' },
    });
    void this.notifications.notify({
      tenantId:   call.tenantId,
      businessId: call.businessId,
      recipients: call.conversation?.assignedToId ? { userIds: [call.conversation.assignedToId] } : { roles: AGENT_ROLES },
      type:       'MISSED_CALL',
      title:      `Missed call from ${call.contact.name || call.contact.phone}`,
      body:       'They called your WhatsApp number and nobody picked up.',
      href:       call.conversationId ? `/inbox?c=${call.conversationId}` : '/calls',
      data:       { callId: call.id, conversationId: call.conversationId },
    });
  }

  /** Conditional state change; returns true when a row actually moved. */
  async transition(
    callId: string,
    from: CallStatusValue[],
    data: Partial<{ status: CallStatusValue; answeredAt: Date; endedAt: Date; durationSec: number; errorCode: number | null; errorTitle: string | null }>,
  ): Promise<boolean> {
    const res = await this.prisma.call.updateMany({ where: { id: callId, status: { in: from } }, data });
    if (res.count === 0) return false;
    await this.afterTransition(callId);
    return true;
  }

  /** Broadcast the new state and keep the thread's system bubble + preview in step. */
  private async afterTransition(callId: string) {
    const call = await this.prisma.call.findUnique({
      where:   { id: callId },
      include: { answeredBy: { select: { id: true, name: true } } },
    });
    if (!call) return;

    this.realtime.toBusiness(call.businessId, 'call:status', {
      id: call.id, status: call.status,
      answeredBy: call.answeredBy ? { id: call.answeredBy.id, name: call.answeredBy.name } : null,
      durationSec: call.durationSec, errorTitle: call.errorTitle,
    });

    const meta = (call.metadata as Record<string, unknown> | null) ?? {};
    const systemMessageId = typeof meta.systemMessageId === 'string' ? meta.systemMessageId : null;
    if (systemMessageId) {
      const label = CALL_LABEL[call.status as CallStatusValue] ?? call.status;
      const content = call.status === 'COMPLETED' && call.durationSec != null ? `${label} · ${formatDuration(call.durationSec)}` : label;
      const patch = {
        content,
        metadata: { call: { callId: call.id, status: call.status, direction: call.direction, durationSec: call.durationSec, answeredBy: call.answeredBy?.name ?? null } },
      };
      await this.prisma.message.update({ where: { id: systemMessageId }, data: patch as any }).catch(() => {});
      void this.events.messageUpdated(systemMessageId, patch);
      if (call.conversationId && call.status !== 'MISSED') {
        await this.prisma.conversation.update({ where: { id: call.conversationId }, data: { lastMessagePreview: `📞 ${content}` } }).catch(() => {});
      }
    }
    if (call.status !== 'RINGING' && call.status !== 'CONNECTING' && call.status !== 'IN_PROGRESS') {
      await this.redis.client.del(this.offerKey(call.waCallId)).catch(() => {});
    }
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  async list(scope: TenantScope, query: { page?: number; limit?: number; status?: string; contactId?: string; conversationId?: string }) {
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 30);
    const where: any = { tenantId: scope.tenantId, businessId: scope.businessId };
    if (query.status)         where.status = query.status;
    if (query.contactId)      where.contactId = query.contactId;
    if (query.conversationId) where.conversationId = query.conversationId;

    const [items, total] = await Promise.all([
      this.prisma.call.findMany({
        where, skip: (page - 1) * limit, take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          contact:    { select: { id: true, name: true, phone: true, avatarUrl: true } },
          answeredBy: { select: { id: true, name: true } },
          // So the call list can offer the recording where the call is, rather than
          // sending someone to a separate page to find the one they are looking at.
          recording:  { select: { id: true, durationSec: true, sizeBytes: true } },
        },
      }),
      this.prisma.call.count({ where }),
    ]);
    return { success: true, data: items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /** One call; while it rings, includes Meta's SDP offer so the answering browser can build its answer. */
  async get(scope: TenantScope, id: string) {
    const call = await this.prisma.call.findFirst({
      where:   { id, tenantId: scope.tenantId, businessId: scope.businessId },
      include: {
        contact:    { select: { id: true, name: true, phone: true, avatarUrl: true } },
        answeredBy: { select: { id: true, name: true } },
      },
    });
    if (!call) throw new NotFoundException('Call not found');
    const offerSdp = call.status === 'RINGING' ? await this.redis.client.get(this.offerKey(call.waCallId)) : null;
    return { ...call, offerSdp };
  }

  // ── Per-number enablement (mirrors Meta's setting) ──────────────────────────

  async getCallingSettings(scope: TenantScope, integrationId: string) {
    const { integration, phoneNumberId, accessToken } = await this.credentials(integrationId, scope);
    let remote: Awaited<ReturnType<MetaCallsClient['getSettings']>> = null;
    let error: string | null = null;
    try {
      remote = await this.meta.getSettings(phoneNumberId, accessToken);
    } catch (err: any) {
      error = err?.message ?? 'Could not read calling settings from Meta';
    }
    const enabled = remote ? remote.status === 'ENABLED' : integration.callingEnabled;
    if (remote && enabled !== integration.callingEnabled) {
      await this.prisma.whatsAppIntegration.update({ where: { id: integration.id }, data: { callingEnabled: enabled } });
    }
    return {
      integrationId: integration.id,
      enabled,
      followBusinessHours: integration.callingFollowsBusinessHours,
      remote,
      error,
    };
  }

  /**
   * @param followBusinessHours When true, the department's hours decide, and `enabled`
   *   only sets where the number starts until the scheduler next runs. Switching it off
   *   leaves calling wherever it currently is rather than forcing it on, so turning the
   *   schedule off at night does not start ringing phones nobody is at.
   */
  async setCallingEnabled(
    scope: TenantScope,
    integrationId: string,
    enabled: boolean,
    followBusinessHours?: boolean,
  ) {
    const { integration, phoneNumberId, accessToken } = await this.credentials(integrationId, scope);
    try {
      await this.meta.setCalling(phoneNumberId, accessToken, enabled);
    } catch (err) {
      throw new BadRequestException(err instanceof MetaCallError ? `Meta refused: ${err.message}` : 'Could not update calling settings');
    }
    await this.prisma.whatsAppIntegration.update({
      where: { id: integration.id },
      data:  {
        callingEnabled: enabled,
        ...(followBusinessHours !== undefined ? { callingFollowsBusinessHours: followBusinessHours } : {}),
      },
    });
    return { integrationId: integration.id, enabled, followBusinessHours };
  }

  // ── Recordings ──────────────────────────────────────────────────────────────

  /**
   * Stores the audio the agent's browser captured for a call.
   *
   * One file per call, replacing any earlier attempt rather than accumulating: a retry
   * after a failed upload should leave one recording, not two nobody can tell apart.
   * Nothing is written until the file is actually stored, so a row that exists always
   * has audio behind it.
   */
  async saveRecording(
    scope: TenantScope,
    callId: string,
    file: { buffer: Buffer; mimetype?: string; size?: number } | undefined,
    durationSec?: number,
  ) {
    // What actually arrived, before anything is rejected. A failed upload leaves nothing
    // behind to inspect — the audio is gone and the call is over — so the only way to
    // tell "the browser sent nothing" from "the proxy dropped it" is to write it down
    // as it happens.
    this.logger.log(
      `[recording] call=${callId} file=${file ? 'yes' : 'NO'} ` +
      `field=${(file as { fieldname?: string } | undefined)?.fieldname ?? '-'} ` +
      `name=${(file as { originalname?: string } | undefined)?.originalname ?? '-'} ` +
      `mime=${file?.mimetype ?? '-'} size=${file?.size ?? 0} ` +
      `buffer=${file?.buffer?.length ?? 0} durationSec=${durationSec ?? '-'}`,
    );

    // Three different failures used to read as one message, which made a failed upload
    // impossible to diagnose from the browser console alone.
    if (!file) {
      this.logger.warn(`[recording] call=${callId} no file part in the request`);
      throw new BadRequestException(
        'No audio reached the server. The upload was sent without a file part.',
      );
    }
    if (!file.buffer?.length) {
      this.logger.warn(`[recording] call=${callId} file part present but empty (size=${file.size ?? 0})`);
      throw new BadRequestException(
        'The audio file was empty. The recording captured nothing — this usually means the tab lost the call before it ended.',
      );
    }

    const call = await this.find(scope, callId);

    const mimeType = file.mimetype || 'audio/webm';
    const key = this.storage.mediaKey({
      tenantId:   scope.tenantId,
      businessId: scope.businessId,
      id:         `call-${call.id}`,
      mimeType,
    });

    this.logger.log(`[recording] call=${call.id} storing ${file.buffer.length} bytes at ${key}`);
    try {
      await this.storage.put(key, file.buffer, mimeType);
    } catch (err) {
      // Storage being unconfigured is a deployment problem, not the caller's — but it
      // looks identical to a broken upload unless it says so.
      this.logger.error(`[recording] call=${call.id} storage failed: ${(err as Error).message}`);
      throw new BadRequestException(
        'The audio could not be stored. Media storage is not reachable — tell an administrator.',
      );
    }

    const recording = await this.prisma.callRecording.upsert({
      where:  { callId: call.id },
      create: {
        callId: call.id, tenantId: scope.tenantId, businessId: scope.businessId,
        storageKey: key, mimeType, sizeBytes: file.size ?? file.buffer.length,
        durationSec: durationSec ?? call.durationSec ?? null,
      },
      update: {
        storageKey: key, mimeType, sizeBytes: file.size ?? file.buffer.length,
        durationSec: durationSec ?? call.durationSec ?? null,
      },
    });

    this.logger.log(`[recording] call=${call.id} stored id=${recording.id} ${recording.sizeBytes} bytes`);
    return { id: recording.id, callId: call.id, sizeBytes: recording.sizeBytes };
  }

  /** Recordings for this department, newest first, with who was on the call. */
  async listRecordings(scope: TenantScope, query: { page?: number; limit?: number } = {}) {
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);

    const where = { tenantId: scope.tenantId, businessId: scope.businessId };
    const [rows, total] = await Promise.all([
      this.prisma.callRecording.findMany({
        where, skip: (page - 1) * limit, take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          call: {
            select: {
              id: true, direction: true, status: true, fromPhone: true, toPhone: true,
              ringingAt: true, answeredAt: true, endedAt: true, durationSec: true,
              contact: { select: { id: true, name: true, phone: true } },
              answeredBy: { select: { id: true, name: true } },
            },
          },
        },
      }),
      this.prisma.callRecording.count({ where }),
    ]);

    return { recordings: rows, total, page, limit };
  }

  /**
   * A short-lived link to the audio.
   *
   * Signed on demand rather than stored, so a recording cannot be reached by anyone who
   * once saw its address, and access is decided per request against this department.
   */
  async recordingUrl(scope: TenantScope, recordingId: string) {
    const recording = await this.prisma.callRecording.findFirst({
      where: { id: recordingId, tenantId: scope.tenantId, businessId: scope.businessId },
    });
    if (!recording) throw new NotFoundException('Recording not found');

    const url = await this.storage.presignGet(recording.storageKey, 3600);
    return { url, expiresInSec: 3600, mimeType: recording.mimeType };
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private async find(scope: TenantScope, callId: string) {
    const call = await this.prisma.call.findFirst({ where: { id: callId, tenantId: scope.tenantId, businessId: scope.businessId } });
    if (!call) throw new NotFoundException('Call not found');
    return call;
  }

  private async credentials(integrationId: string, scope?: TenantScope) {
    const integration = await this.prisma.whatsAppIntegration.findFirst({
      where: { id: integrationId, ...(scope ? { businessId: scope.businessId } : {}) },
    });
    if (!integration) throw new NotFoundException('WhatsApp number not found');
    const accessToken = integration.accessToken ? decryptSecret(integration.accessToken) : null;
    if (!accessToken) throw new BadRequestException('WhatsApp number has no usable access token');
    return { integration, phoneNumberId: integration.phoneNumberId, accessToken };
  }
}

export interface RTCIceServerLike {
  urls: string[];
  username?: string;
  credential?: string;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
}
