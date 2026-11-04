CREATE TABLE IF NOT EXISTS "plan_renewal_payments" (
  "id"                TEXT         NOT NULL,
  "tenantId"          TEXT         NOT NULL,
  "razorpayPaymentId" TEXT         NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plan_renewal_payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "plan_renewal_payments_razorpayPaymentId_key"
  ON "plan_renewal_payments" ("razorpayPaymentId");
CREATE INDEX IF NOT EXISTS "plan_renewal_payments_tenantId_createdAt_idx"
  ON "plan_renewal_payments" ("tenantId", "createdAt");
