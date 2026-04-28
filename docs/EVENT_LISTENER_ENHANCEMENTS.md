# Event Listener Enhancements

This document details the enhancements implemented for the Stellar Event Listener infrastructure.

## 1. Schema Validation (Issue #53)
All incoming contract events are now validated against strictly defined schemas using **Zod**.
- **Supported Events**: `deposit`, `withdraw`, `rebalance`.
- Validation ensures proper addresses, positive amounts, and expected formats.
- Invalid payloads are rejected safely and directed to the Dead-Letter Queue (DLQ) to avoid listener crashes.

## 2. Dead-Letter Queue - DLQ (Issue #54)
A lightweight, JSON-persisted Dead-Letter Queue tracks unparseable or failed events.
- **Location**: `logs/dead_letter_queue.json`.
- Failed transactions fallback safely without blocking the stream.
- **Manual Intervention**: Accessible programmatic methods allow operators to force retries.
- **Monitoring**: Automated warnings fire when the DLQ reaches critical event sizes.

## 3. Batch Processing (Issue #55)
To improve overall system throughput and reduce redundant overhead:
- Multiple events are grouped and committed within a single atomic **Prisma Transaction**.
- Yields higher processing speeds and keeps DB load optimized.

## 4. Backfill & Fault Recovery (Issue #59)
Designed to guarantee no event data loss across system downtimes:
- Starts from the latest known DB cursor.
- Range reprocessing pulls and synchronizes missed ledgers reliably on startup.
