# Support Ticket System Architecture (#552)

## Overview
The General-Purpose Support Ticket System provides users with a structured, tracked mechanism to raise issues, submit questions, and interact with support admins through resolution. Structurally similar to the compliance-case system, support tickets are fully user-visible and collaborative.

## Data Model
- **SupportTicket**: Represents a support ticket (`id`, `userId`, `subject`, `category`, `status`, `priority`, `assignedTo`, `contextRef`, `slaBreached`, `createdAt`, `updatedAt`, `resolvedAt`).
- **TicketMessage**: An append-only thread message (`id`, `ticketId`, `authorUserId`, `authorRole`, `body`, `attachmentRefs`, `internal`, `createdAt`).

### Status State Machine
- `OPEN` → `IN_PROGRESS` → `AWAITING_USER` → `RESOLVED` → `CLOSED`
- **Auto-Reopen**: When a user replies to a ticket in `RESOLVED` status, the ticket automatically reopens to `IN_PROGRESS` with `resolvedAt` reset to `null`.

## Security & Privacy Boundary
- **Owner-Scoped Read/Reply**: Users can only view and reply to their own tickets.
- **Internal Note Isolation**: Admin notes marked `internal: true` are filtered out at the **database query level** on all user-facing read paths (`where: { internal: false }`).
- **Audit Logging**: All admin updates (status, priority, assignment) and admin replies are recorded in audit logs.
- **Rate Limiting**: Ticket creation is protected by rate limiting to prevent abuse.

## API Endpoints
- User-facing:
  - `POST /api/v1/support/tickets` - Create new ticket
  - `GET /api/v1/support/tickets` - List user tickets
  - `GET /api/v1/support/tickets/:id` - View ticket thread
  - `POST /api/v1/support/tickets/:id/reply` - User reply
- Admin-facing:
  - `GET /api/v1/admin/support/tickets` - Filterable ticket queue (status, category, assignee, SLA)
  - `PATCH /api/v1/admin/support/tickets/:id` - Manage status, priority, assignment
  - `POST /api/v1/admin/support/tickets/:id/reply` - Admin reply or internal note

Admin reads require support:read; updates and replies require support:write. Status transitions are enforced and status/assignment/priority changes commit with an audit record. SLA defaults are LOW 72h, MEDIUM 24h, HIGH 8h and URGENT 2h. Override these with SUPPORT_SLA_<PRIORITY>_HOURS. Breaches are computed from creation time and exclude resolved/closed tickets. Internal notes are filtered by the database on user reads. User replies to RESOLVED or AWAITING_USER move the ticket to IN_PROGRESS.

## SLA, transitions and alerting (#618)

Priorities map to the usual P-levels: `URGENT` = P0, `HIGH` = P1, `MEDIUM` = P2, `LOW` = P3.

| Priority | Response SLA (default) | Override |
|---|---|---|
| URGENT (P0) | 2h | `SUPPORT_SLA_URGENT_HOURS` |
| HIGH (P1) | 8h | `SUPPORT_SLA_HIGH_HOURS` |
| MEDIUM (P2) | 24h | `SUPPORT_SLA_MEDIUM_HOURS` |
| LOW (P3) | 72h | `SUPPORT_SLA_LOW_HOURS` |

- `firstResponseAt` is set once, on the first non-internal admin reply. The SLA is met when
  `firstResponseAt <= createdAt + SLA`. A ticket with no response is breached once the deadline
  passes and it is not yet `RESOLVED`/`CLOSED`. `resolvedAt` is set when the ticket reaches `RESOLVED`.
- Allowed transitions (anything else returns `409`):
  `OPEN -> IN_PROGRESS | AWAITING_USER | RESOLVED`, `IN_PROGRESS -> AWAITING_USER | RESOLVED`,
  `AWAITING_USER -> IN_PROGRESS | RESOLVED`, `RESOLVED -> IN_PROGRESS (reopen) | CLOSED`, `CLOSED` is terminal.
- `src/jobs/supportTicketSla.ts` runs every `SUPPORT_SLA_CHECK_INTERVAL_MS` (default 5 min). It sets
  `slaBreached`, publishes `support_tickets_sla_breached{priority}` and `support_tickets_stale`, and
  alerts through `alertingService` (critical for URGENT/HIGH breaches).
- A ticket is stale when it is open (not `AWAITING_USER`) and untouched for `SUPPORT_STALE_HOURS`
  (default 24).
- Prometheus rules `SupportTicketSlaBreached`, `SupportUrgentTicketSlaBreached` and
  `SupportTicketsStale` live in `deploy/monitoring/prometheus/alert-rules.yaml`.
