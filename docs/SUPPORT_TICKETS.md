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
