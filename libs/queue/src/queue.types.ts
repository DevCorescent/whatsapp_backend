// ── Inbound message job (replaces QStash inbound topic) ──────────────────────
export interface InboundMessageJob {
  tenantId:               string;
  businessId:             string;
  phoneNumberId:          string;
  whatsappIntegrationId:  string | null;
  waMessageId:            string;
  from:                   string;
  contactName?:           string;
  contactWaId?:           string;
  type:                   string;
  content:                string | null;
  timestamp:              string;
  rawMessage:             unknown;
}

// ── AI reply job (replaces QStash ai-reply topic) ────────────────────────────
export interface AiReplyJob {
  tenantId:       string;
  businessId:     string;
  conversationId: string;
  waMessageId:    string; // trigger message wamid — used for idempotency check
  delay?:         number;
}

// ── Campaign send job ─────────────────────────────────────────────────────────
export interface CampaignSendJob {
  tenantId:    string;
  businessId:  string;
  campaignId:  string;
  recipientId: string;
}
