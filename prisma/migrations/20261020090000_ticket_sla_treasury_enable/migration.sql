ALTER TABLE "support_tickets" ADD COLUMN "firstResponseAt" TIMESTAMP(3);

UPDATE "support_tickets" t
SET "firstResponseAt" = m.first_reply
FROM (
  SELECT "ticketId", MIN("createdAt") AS first_reply
  FROM "ticket_messages"
  WHERE "authorRole" = 'ADMIN' AND "internal" = false
  GROUP BY "ticketId"
) m
WHERE m."ticketId" = t."id";

ALTER TABLE "treasury_sweep_policies"
  ADD COLUMN "sweepsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "enabledBy" TEXT,
  ADD COLUMN "enabledAt" TIMESTAMP(3);
