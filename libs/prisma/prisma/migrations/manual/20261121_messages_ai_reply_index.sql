-- The inbox's AI tab asks "has this thread an AI reply in it", which Prisma runs as an
-- EXISTS over messages for each candidate conversation. Without an index that is a scan
-- of every message a workspace has ever sent, on every keystroke of the tab.
--
-- Partial on purpose: only the rows the filter cares about are indexed, which on a real
-- workspace is a small fraction of the table, so it costs little to keep and nothing to
-- maintain for ordinary messages.
--
-- CONCURRENTLY so it does not lock the table; it cannot run inside a transaction, so this
-- file must be applied on its own.
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_ai_reply_idx
  ON messages ("conversationId")
  WHERE "isAiGenerated";
