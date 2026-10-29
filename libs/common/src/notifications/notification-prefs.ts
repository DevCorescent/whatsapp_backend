// Per-user notification preferences — mirrored in the frontend at lib/notifications/prefs.ts.

export type NotificationEvent =
  | 'newMessage'
  | 'missedCall'
  | 'campaignCompleted'
  | 'conversationAssigned'
  | 'leadAssigned';

export interface ChannelPrefs {
  /** Bell + toast while the app is open. */
  inApp: boolean;
  /** OS notification via web push when no tab is focused. */
  desktop: boolean;
  /** Short sound with the toast. */
  sound: boolean;
  email: boolean;
}

export type NotificationPrefs = Record<NotificationEvent, ChannelPrefs>;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  newMessage:           { inApp: true, desktop: true,  sound: true,  email: false },
  missedCall:           { inApp: true, desktop: true,  sound: true,  email: false },
  campaignCompleted:    { inApp: true, desktop: false, sound: false, email: true },
  conversationAssigned: { inApp: true, desktop: true,  sound: true,  email: false },
  leadAssigned:         { inApp: true, desktop: false, sound: false, email: true },
};

/** NotificationType enum value → preference key. */
export const EVENT_FOR_TYPE: Record<string, NotificationEvent | undefined> = {
  NEW_MESSAGE:           'newMessage',
  MISSED_CALL:           'missedCall',
  CAMPAIGN_COMPLETED:    'campaignCompleted',
  CONVERSATION_ASSIGNED: 'conversationAssigned',
  LEAD_ASSIGNED:         'leadAssigned',
};

export function mergePrefs(stored: unknown): NotificationPrefs {
  const out = { ...DEFAULT_NOTIFICATION_PREFS };
  if (!stored || typeof stored !== 'object') return out;
  const s = stored as Partial<Record<NotificationEvent, Partial<ChannelPrefs>>>;
  for (const key of Object.keys(DEFAULT_NOTIFICATION_PREFS) as NotificationEvent[]) {
    const v = s[key];
    if (v && typeof v === 'object') out[key] = { ...DEFAULT_NOTIFICATION_PREFS[key], ...pickBools(v) };
  }
  return out;
}

function pickBools(v: Partial<ChannelPrefs>): Partial<ChannelPrefs> {
  const out: Partial<ChannelPrefs> = {};
  for (const k of ['inApp', 'desktop', 'sound', 'email'] as const) {
    if (typeof v[k] === 'boolean') out[k] = v[k];
  }
  return out;
}
