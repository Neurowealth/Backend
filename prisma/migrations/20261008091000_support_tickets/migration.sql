CREATE TYPE "TicketCategory" AS ENUM ('ACCOUNT', 'TRANSACTION', 'TAX', 'TECHNICAL', 'OTHER');
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'AWAITING_USER', 'RESOLVED', 'CLOSED');
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
CREATE TYPE "MessageAuthorRole" AS ENUM ('USER', 'ADMIN');
CREATE TABLE "support_tickets" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "subject" TEXT NOT NULL,
  "category" "TicketCategory" NOT NULL, "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
  "priority" "TicketPriority" NOT NULL DEFAULT 'MEDIUM', "assignedTo" TEXT, "contextRef" TEXT,
  "slaBreached" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_tickets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "ticket_messages" (
  "id" TEXT NOT NULL, "ticketId" TEXT NOT NULL, "authorUserId" TEXT,
  "authorRole" "MessageAuthorRole" NOT NULL DEFAULT 'USER', "body" TEXT NOT NULL,
  "attachmentRefs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "internal" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ticket_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "support_tickets_userId_idx" ON "support_tickets"("userId");
CREATE INDEX "support_tickets_status_idx" ON "support_tickets"("status");
CREATE INDEX "support_tickets_category_idx" ON "support_tickets"("category");
CREATE INDEX "support_tickets_assignedTo_idx" ON "support_tickets"("assignedTo");
CREATE INDEX "support_tickets_slaBreached_idx" ON "support_tickets"("slaBreached");
CREATE INDEX "ticket_messages_ticketId_idx" ON "ticket_messages"("ticketId");
CREATE INDEX "ticket_messages_ticketId_internal_idx" ON "ticket_messages"("ticketId", "internal");
