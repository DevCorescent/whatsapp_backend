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

  setCalling(phoneNumberId: string, accessToken: string, enabled: boolean) {
    return this.post(phoneNumberId, accessToken, 'settings', {
      calling: {
        status:               enabled ? 'ENABLED' : 'DISABLED',
        call_icon_visibility: enabled ? 'DEFAULT' : 'DISABLE_ALL',
      },
    });
  }
}
