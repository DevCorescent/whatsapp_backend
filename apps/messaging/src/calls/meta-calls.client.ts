import { Injectable, Logger } from '@nestjs/common';
import { WA_API_VERSION } from '@lib/common';

export interface MetaCallingSettings {
  status: 'ENABLED' | 'DISABLED';
  call_icon_visibility?: 'DEFAULT' | 'DISABLE_ALL';
  callback_permission_status?: 'ENABLED' | 'DISABLED';
}

export class MetaCallError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) {
    super(message);
  }
}

/** Meta's code for "this user has not allowed this business to call them". */
export const NO_CALL_PERMISSION = 138006;

/**
 * What Meta says a business may currently do with one user, from
 * `GET /{phone_number_id}/call_permissions`.
 *
 * The limits are read rather than assumed. Meta changes them — business-initiated calls
 * went from 10 a day to 100 in December 2025 — and a number hard-coded here would start
 * refusing calls Meta would have allowed, with nothing on screen to explain why.
 */
export interface CallPermissionLimit {
  time_period: string;
  max_allowed: number;
  current_usage: number;
  limit_expiration_time?: number;
}

export interface CallPermissionAction {
  action_name: 'send_call_permission_request' | 'start_call' | string;
  can_perform_action: boolean;
  limits?: CallPermissionLimit[];
}

export interface CallPermissionState {
  permission?: {
    status: 'temporary' | 'permanent' | 'no_permission' | string;
    expiration_time?: number;
  };
  actions?: CallPermissionAction[];
}

/** Thin wrapper over Meta's Calling API (POST /{phone_number_id}/calls and /settings). */
@Injectable()
export class MetaCallsClient {
  private readonly logger = new Logger(MetaCallsClient.name);

  private async post(phoneNumberId: string, accessToken: string, path: string, body: Record<string, unknown>) {
    const res = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/${path}`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      let code: number | undefined;
      try {
        const json = JSON.parse(text);
        message = json?.error?.message ?? message;
        code = json?.error?.code;
      } catch { /* raw */ }
      this.logger.warn(`Meta ${path} ${res.status}: ${message}`);
      throw new MetaCallError(message, res.status, code);
    }
    try { return JSON.parse(text); } catch { return {}; }
  }

  private action(phoneNumberId: string, accessToken: string, body: Record<string, unknown>) {
    return this.post(phoneNumberId, accessToken, 'calls', { messaging_product: 'whatsapp', ...body });
  }

  /**
   * Starts a business-initiated call.
   *
   * The other actions answer a call Meta already told us about; this one creates it, so
   * it sends an offer rather than an answer and gets the call id back instead of being
   * given one. The customer must have messaged within the last 24 hours or have granted
   * call permission — Meta refuses otherwise, and says which.
   */
  async connect(phoneNumberId: string, accessToken: string, toPhone: string, sdp: string) {
    const res = await this.action(phoneNumberId, accessToken, {
      to: toPhone,
      action: 'connect',
      session: { sdp_type: 'offer', sdp },
    });
    const callId = res?.calls?.[0]?.id as string | undefined;
    if (!callId) throw new MetaCallError('Meta accepted the call but returned no call id', 502);
    return { callId };
  }

  preAccept(phoneNumberId: string, accessToken: string, callId: string, sdp: string) {
    return this.action(phoneNumberId, accessToken, { call_id: callId, action: 'pre_accept', session: { sdp_type: 'answer', sdp } });
  }

  accept(phoneNumberId: string, accessToken: string, callId: string, sdp: string, opaque?: string) {
    return this.action(phoneNumberId, accessToken, {
      call_id: callId, action: 'accept', session: { sdp_type: 'answer', sdp },
      ...(opaque ? { biz_opaque_callback_data: opaque } : {}),
    });
  }

  reject(phoneNumberId: string, accessToken: string, callId: string) {
    return this.action(phoneNumberId, accessToken, { call_id: callId, action: 'reject' });
  }

  terminate(phoneNumberId: string, accessToken: string, callId: string) {
    return this.action(phoneNumberId, accessToken, { call_id: callId, action: 'terminate' });
  }

  async getSettings(phoneNumberId: string, accessToken: string): Promise<MetaCallingSettings | null> {
    const res = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/settings`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new MetaCallError((await res.text()).slice(0, 300), res.status);
    const json = (await res.json()) as { calling?: MetaCallingSettings };
    return json.calling ?? null;
  }

  /**
   * Whether this business may call this user right now, and whether it may ask.
   *
   * Meta is the only honest source for this: permission expires, it is revoked after
   * four unanswered calls, and both the call and the request carry their own rate
   * limits. Guessing locally would mean offering a button that Meta then refuses.
   */
  async getCallPermission(
    phoneNumberId: string,
    accessToken: string,
    userWaId: string,
  ): Promise<CallPermissionState> {
    const url =
      `https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/call_permissions` +
      `?user_wa_id=${encodeURIComponent(userWaId)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      let code: number | undefined;
      try {
        const json = JSON.parse(text);
        message = json?.error?.message ?? message;
        code = json?.error?.code;
      } catch { /* raw */ }
      throw new MetaCallError(message, res.status, code);
    }
    try { return JSON.parse(text) as CallPermissionState; } catch { return {}; }
  }

  /**
   * Asks the user, inside WhatsApp, to allow calls from this business.
   *
   * It is an ordinary interactive message, so it lands in their chat and their answer
   * comes back as a `call_permission_reply` webhook. WhatsApp writes the prompt itself;
   * `bodyText` is the line of context above it.
   */
  sendCallPermissionRequest(
    phoneNumberId: string,
    accessToken: string,
    toPhone: string,
    bodyText?: string,
  ) {
    return this.post(phoneNumberId, accessToken, 'messages', {
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to:                toPhone,
      type:              'interactive',
      interactive: {
        type:   'call_permission_request',
        action: { name: 'call_permission_request' },
        ...(bodyText?.trim() ? { body: { text: bodyText.trim() } } : {}),
      },
    });
  }

  setCalling(phoneNumberId: string, accessToken: string, enabled: boolean) {
    return this.post(phoneNumberId, accessToken, 'settings', {
      calling: {
        status:               enabled ? 'ENABLED' : 'DISABLED',
        call_icon_visibility: enabled ? 'DEFAULT' : 'DISABLE_ALL',
      },
    });
  }
}
