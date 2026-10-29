export interface WAWebhookPayload {
  object: string;
  entry: WAEntry[];
}

export interface WAEntry {
  id: string;
  changes: WAChange[];
}

export interface WAChange {
  value: WAChangeValue;
  field: string;
}

export interface WAChangeValue {
  messaging_product: string;
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: WAContact[];
  messages?: WAMessage[];
  statuses?: WAStatus[];
  /** `calls` webhook field — see WACall. */
  calls?: WACall[];
  errors?: Array<{ code: number; title?: string; message?: string; error_data?: { details?: string } }>;
}

/** One entry of the `calls` webhook field (Meta Calling API). */
export interface WACall {
  id: string;                 // wacid.…
  from?: string;              // caller wa_id (user-initiated)
  to: string;                 // business display number
  from_user_id?: string;
  event: 'connect' | 'terminate' | string;
  timestamp: string;
  direction: 'USER_INITIATED' | 'BUSINESS_INITIATED';
  session?: { sdp_type: 'offer' | 'answer'; sdp: string };
  status?: 'COMPLETED' | 'FAILED' | string;
  start_time?: string;
  end_time?: string;
  duration?: number;
  biz_opaque_callback_data?: string;
}

export interface WAContact {
  wa_id: string;
  bsuid?: string;
  username?: string;
  profile: { name: string };
}

export interface WAMessage {
  id: string;        // wamid
  from: string;      // sender's wa_id
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: WAMedia & { caption?: string };
  audio?: WAMedia & { voice?: boolean };
  video?: WAMedia & { caption?: string };
  document?: WAMedia & { filename?: string; caption?: string };
  sticker?: WAMedia & { animated?: boolean };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  interactive?: { type: string; button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
  button?: { payload: string; text: string };
  reaction?: { message_id: string; emoji: string };
  context?: { from: string; id: string };
  errors?: Array<{ code: number; title: string }>;
}

export interface WAMedia {
  id: string;
  mime_type?: string;
  sha256?: string;
}

export const WA_MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

/** The media attachment on an inbound message, if it carries one. */
export function mediaOf(message: WAMessage): { mediaId: string; mimeType?: string; filename?: string } | null {
  if (!WA_MEDIA_TYPES.has(message.type)) return null;
  const m = (message as unknown as Record<string, WAMedia & { filename?: string } | undefined>)[message.type];
  if (!m?.id) return null;
  return { mediaId: m.id, mimeType: m.mime_type, filename: m.filename };
}

export interface WAStatus {
  id: string;        // wamid (or wacid for call statuses)
  status: string;    // sent | delivered | read | failed | RINGING | ACCEPTED | REJECTED
  /** 'call' for Calling API status updates; absent for message statuses. */
  type?: string;
  timestamp: string;
  recipient_id: string;
  conversation?: { id: string; origin?: { type: string } };
  pricing?: { billable: boolean; pricing_model: string; category: string };
  errors?: Array<{ code: number; title: string }>;
}
