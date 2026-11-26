# PDF Exports: PII, Resource Caps and Cleanup

PDF reports (for example `GET /api/v1/analytics/user-yield/export?format=pdf`)
contain personal financial data. Rendering is synchronous and memory-heavy, so
the same pods that serve traffic must not be able to spend unbounded CPU or
memory on a single document.

## Input caps (#670)

| Env var                   | Default          | Breach response                           |
| ------------------------- | ---------------- | ----------------------------------------- |
| `PDF_MAX_LINES`           | 10,000 lines     | `422 PDF_INPUT_TOO_LARGE`                 |
| `PDF_MAX_LINE_LENGTH`     | 4,000 characters | `422 PDF_INPUT_TOO_LARGE`                 |
| `PDF_MAX_INPUT_BYTES`     | 4 MiB            | `422 PDF_INPUT_TOO_LARGE`                 |
| `PDF_MAX_CONCURRENT`      | 2 generations    | `429 PDF_GENERATION_BUSY` + `Retry-After` |
| `PDF_RETRY_AFTER_SECONDS` | 5                | Value of the `Retry-After` header         |

Limits are enforced by `toSimplePdf`; routes use `generateSimplePdf`, which
also acquires the process-wide semaphore in `src/utils/pdf.ts`. The semaphore
rejects immediately instead of queueing: queueing would only move the same
memory pressure a few milliseconds later and hide it from the caller.

## Memory ceiling

`npm run profile:pdf` regenerates the profile below. It renders reports of
100 / 1,000 / 5,000 / 10,000 lines and reports RSS and heap deltas. Reference
run (Node 22, 10,000-line cap):

| Input lines | PDF bytes | RSS delta |   Heap delta |
| ----------- | --------: | --------: | -----------: |
| 100         |    ~7 KiB |    ~0 MiB |     ~0.1 MiB |
| 1,000       |   ~67 KiB |  ~0.4 MiB |     ~2.6 MiB |
| 5,000       |  ~341 KiB |   ~36 MiB |      ~41 MiB |
| 10,000      |  ~683 KiB |   ~36 MiB | GC-dependent |

The full profile run stayed under ~72 MiB total RSS growth. With the default
two-concurrent cap the expected worst case is therefore roughly 150 MiB above
the pod's idle footprint, and the 4 MiB input cap bounds the user-controlled
part of that. Load-test the endpoint with `tests/load/pdf-export.js` before
changing these caps.

## Download safety

- The PDF route requires `requireAuth`; user identity scopes the query.
- Responses carry `Cache-Control: private, no-store, max-age=0`,
  `Pragma: no-cache` and `Expires: 0`.
- Content includes balances and identifiers, never API keys, bearer tokens, or
  full account numbers.
- The current path renders directly to an in-memory `Buffer`; it writes no temp
  file, so success and failure both leave nothing behind.
- If a future pipeline needs a temp path, use `withPdfTempFile` in
  `src/utils/pdfTempFiles.ts`: mode `0600`, private directory, unconditional
  unlink in `finally`, and a TTL sweep (`sweepPdfTempFiles`) for leftovers from
  an unclean shutdown. Unit tests cover success, thrown callback, and stale-file
  removal.
