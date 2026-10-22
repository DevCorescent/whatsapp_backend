-- Migration: add messagingTier to whatsapp_integrations
-- Run once against production DB.
-- Tier values: 1=250/day, 2=2000/day, 3=10000/day, 4=100000/day, 0=unlimited

ALTER TABLE whatsapp_integrations
  ADD COLUMN IF NOT EXISTS "messagingTier" INTEGER NOT NULL DEFAULT 1;
