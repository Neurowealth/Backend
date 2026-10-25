# Dependency & Security Audit Backlog

Tracks the health of every direct dependency, known advisories, and the
remediation plan needed for production readiness. Refs
[#467](https://github.com/Neurowealth/Backend/issues/467).

|                  |                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------- |
| **Last audited** | 2026-09-27                                                                         |
| **Next review**  | 2026-10-27 (monthly, and whenever CI's audit gate fails)                           |
| **Owner**        | Backend maintainers ([CODEOWNERS](../.github/CODEOWNERS): @BernardOnuh)            |
| **Tree size**    | 29 runtime + 25 dev direct deps; 434 packages in the production tree, 847 in total |

## How to re-run the audit

```bash
npm ci
npm run audit:deps       # npm audit, fails on moderate or above
npm run outdated:deps    # npm outdated (exits 0; informational)
npm audit --omit=dev     # runtime-only exposure
```

CI and release verification run `npm run audit:production`, which blocks on
every unexcepted **moderate, high, or critical production advisory**.
Dependabot opens grouped weekly PRs for minor/patch updates. The weekly
[`dependency-audit`](../.github/workflows/dependency-audit.yml) workflow
uploads the full `npm audit` / `npm outdated` JSON as an artifact so this
document can be refreshed from real data.

## Known advisories

| Advisory                                                                                                                   | Package (path)                                           | Severity | Status                                                                               |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g): DoS via attacker-controlled `isBuffer`           | `qs` 6.15.3 (via `express` 4.22.2, `body-parser` 1.20.6) | Moderate | **Fixed**: lockfile now resolves `qs` 6.16.0, `express` 4.22.3, `body-parser` 1.20.8 |
| [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx): array-limit bypass via bracket-key comma parsing | `qs` 6.15.3 (same path)                                  | Moderate | **Fixed** (same upgrade)                                                             |

`npm audit` after remediation: **0 vulnerabilities** (0 low, 0 moderate,
0 high, 0 critical).

## High-risk packages: owners and target versions

Priority is based on runtime exposure, whether the installed line is still
supported upstream, and how far behind it is.

| Priority | Package(s)                                                                           | Installed → Target                                | Why it is high-risk                                                                                                                                                                          | Owner               | Target date |
| -------- | ------------------------------------------------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------- |
| P1       | `@prisma/client`, `prisma`                                                           | 5.22.0 → 7.10.x                                   | Two majors behind. `@prisma/instrumentation` is already on 7.x, so tracing runs against a mismatched client major. Needs a migration dry run against staging.                                | Backend maintainers | 2026-11-30  |
| P1       | `express`, `@types/express`                                                          | 4.22.3 → 5.2.x                                    | Core HTTP surface. The `qs`/`body-parser` advisory chain above came in through Express 4. Express 5 changes path matching and async error handling, so every router needs a regression pass. | Backend maintainers | 2026-12-31  |
| P1       | `@stellar/stellar-sdk`                                                               | 16.2.0 → 17.1.x                                   | Signs and submits on-chain transactions. SDK majors follow Stellar protocol upgrades; falling behind risks rejected transactions after a network upgrade.                                    | Backend maintainers | 2026-11-15  |
| P2       | `@sentry/node`, `@sentry/profiling-node`                                             | 10.71.0 → 11.x                                    | Error reporting. The profiling native addon is tied to Node ABI versions.                                                                                                                    | Backend maintainers | 2026-12-31  |
| P2       | `ioredis`                                                                            | 5.11.1 → 6.x                                      | Backs rate limiting and caching on auth-adjacent paths.                                                                                                                                      | Backend maintainers | 2027-01-31  |
| P2       | `@anthropic-ai/sdk`                                                                  | 0.112.5 → 0.128.x                                 | Pre-1.0, so every minor may break; talks to an external paid API.                                                                                                                            | Backend maintainers | 2026-12-31  |
| P2       | `eslint`                                                                             | 8.57.1 → 9.x / 10.x                               | ESLint 8 is end-of-life. The repo already uses flat config (`eslint.config.mjs`), which makes this upgrade simpler. Dev-only.                                                                | Backend maintainers | 2026-12-31  |
| P2       | `@types/node`, `typescript`                                                          | `@types/node` 20 → 22; hold `typescript` on 5.9.x | `@types/node` 20 does not match `engines.node >=22` or the `node:22` Docker image. Hold the TypeScript 7 major until the existing type errors below are fixed.                               | Backend maintainers | 2026-10-31  |
| P3       | OpenTelemetry (`sdk-node`, `exporter-trace-otlp-http`, `auto-instrumentations-node`) | 0.220 / 0.78 → 0.222 / 0.80                       | Pre-1.0 packages whose minors can break. Upgrade them together as one group.                                                                                                                 | Backend maintainers | 2026-11-30  |
| P3       | `dotenv`, `jest`, `@types/jest`, `supertest`                                         | see inventory                                     | Low runtime exposure (`dotenv`) or dev-only.                                                                                                                                                 | Backend maintainers | 2027-03-31  |

### Blocking issue found during the audit

`npx tsc --noEmit` currently fails on `main` (3 errors in the
`tsconfig.build.json` scope), left over from the zod 4 migration:
`z.record(z.any())` in `src/validators/webhook-validators.ts` needs an
explicit key schema, and `src/controllers/user-webhook-controller.ts` passes a
nullable record into a Prisma `Json` field. This also stops the test suites
that load the full app from compiling. It must be fixed before any of the
TypeScript, Prisma or Express upgrades above can be verified.

## Security exceptions

Temporary advisory exceptions live in the machine-readable
`config/dependency-audit-exceptions.json`. Every entry must contain the npm/GHSA
advisory identifier (or affected package name), an accountable GitHub owner, a
specific reason, and an ISO date in `expiresOn`. Expired entries fail the gate.

```json
{
  "advisory": "GHSA-example",
  "owner": "@security-owner",
  "reason": "No patched transitive version; compensating control documented in incident-123",
  "expiresOn": "2026-12-31"
}
```

Exceptions require security review in the PR that adds them and quarterly
review even when their expiry is later. Remove an exception as soon as a fixed
dependency is available. The table below tracks package-version policy and is
not a substitute for advisory exceptions.

Each exception is a deliberate deviation from "latest supported version".
Every exception is reviewed at each monthly audit and removed as soon as its
exit condition is met.

| Exception                                                                                     | Reason                                                                           | Exit condition                                                  | Last reviewed |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------- |
| `overrides.axios: ^1.18.0`                                                                    | Forces a patched `axios` under transitive dependents that pin older ranges.      | Every parent package's own range resolves to a patched release. | 2026-09-27    |
| `overrides.brace-expansion: 5.0.9`                                                            | Pins a patched transitive `brace-expansion` used by glob tooling.                | Parents depend on a fixed range.                                | 2026-09-27    |
| `overrides.ip-address: ^10.5.0`                                                               | Forces a patched transitive `ip-address`.                                        | Parents depend on a fixed range.                                | 2026-09-27    |
| `overrides.js-yaml: ^4.3.1` under `eslint`, `@eslint/eslintrc`, `@istanbuljs/load-nyc-config` | These dev tools pull older js-yaml lines. The runtime uses js-yaml 5.x directly. | The ESLint 9+ / Jest 30 upgrades above remove the old parents.  | 2026-09-27    |
| Dependabot ignores major bumps                                                                | Majors need a deliberate, reviewed upgrade PR (see the table above).             | Permanent policy.                                               | 2026-09-27    |

## Remediation done in this audit

- `npm audit fix` (non-breaking): `express` 4.22.2 → 4.22.3, `body-parser`
  1.20.6 → 1.20.8, `qs` 6.15.3 → 6.16.0, which clears both `qs` advisories.
- Moved `@types/node-cron` and `@types/supertest` from `dependencies` to
  `devDependencies`. They are compile-time only but were being installed into
  the production image by `npm ci --omit=dev`.
- Added the `audit:deps` / `outdated:deps` npm scripts and a weekly
  non-blocking `dependency-audit` workflow.

## Dependency inventory

"Breaking update available" means a new major, or a new minor for `0.x`
packages. Non-breaking updates are picked up by Dependabot's grouped weekly PRs.

### Runtime dependencies (29 direct)

| Package                                     | Range    | Installed | Latest  | Status                        | Purpose                      |
| ------------------------------------------- | -------- | --------- | ------- | ----------------------------- | ---------------------------- |
| `@anthropic-ai/sdk`                         | ^0.112.3 | 0.112.5   | 0.128.0 | **breaking update available** | LLM calls (assistant, NLP)   |
| `@opentelemetry/api`                        | ^1.9.1   | 1.9.1     | 1.9.1   | current                       | Tracing API                  |
| `@opentelemetry/auto-instrumentations-node` | ^0.78.0  | 0.78.0    | 0.80.0  | **breaking update available** | HTTP/DB auto-instrumentation |
| `@opentelemetry/exporter-trace-otlp-http`   | ^0.220.0 | 0.220.0   | 0.222.0 | **breaking update available** | OTLP trace export            |
| `@opentelemetry/resources`                  | ^2.9.0   | 2.10.0    | 2.11.0  | non-breaking update available | Trace resource attrs         |
| `@opentelemetry/sdk-node`                   | ^0.220.0 | 0.220.0   | 0.222.0 | **breaking update available** | Tracing SDK                  |
| `@opentelemetry/sdk-trace-node`             | ^2.9.0   | 2.10.0    | 2.11.0  | non-breaking update available | Tracing SDK                  |
| `@opentelemetry/semantic-conventions`       | ^1.43.0  | 1.43.0    | 1.43.0  | current                       | Trace attribute names        |
| `@prisma/client`                            | ^5.22.0  | 5.22.0    | 7.10.0  | **breaking update available** | Database ORM client          |
| `@prisma/instrumentation`                   | ^7.8.0   | 7.10.0    | 7.10.0  | current                       | Prisma tracing               |
| `@sentry/node`                              | ^10.66.0 | 10.71.0   | 11.0.0  | **breaking update available** | Error reporting              |
| `@sentry/profiling-node`                    | ^10.66.0 | 10.71.0   | 11.0.0  | **breaking update available** | Profiling (native addon)     |
| `@stellar/stellar-sdk`                      | ^16.0.1  | 16.2.0    | 17.1.0  | **breaking update available** | Stellar/Soroban chain access |
| `bcryptjs`                                  | ^3.0.3   | 3.0.3     | 3.0.3   | current                       | Password/key hashing         |
| `cors`                                      | ^2.8.5   | 2.8.6     | 2.8.6   | current                       | CORS                         |
| `dotenv`                                    | ^16.3.1  | 16.6.1    | 18.0.4  | **breaking update available** | Env loading                  |
| `express`                                   | ^4.18.2  | 4.22.3    | 5.2.1   | **breaking update available** | HTTP framework               |
| `express-rate-limit`                        | ^8.6.0   | 8.6.2     | 8.7.0   | non-breaking update available | Rate limiting                |
| `helmet`                                    | ^8.3.0   | 8.3.0     | 8.3.0   | current                       | Security headers             |
| `ioredis`                                   | ^5.11.1  | 5.11.1    | 6.0.0   | **breaking update available** | Redis (rate limits, cache)   |
| `js-yaml`                                   | ^5.2.1   | 5.4.1     | 5.4.2   | non-breaking update available | OpenAPI spec loading         |
| `jsonwebtoken`                              | ^9.0.3   | 9.0.3     | 9.0.3   | current                       | JWT sessions                 |
| `node-cron`                                 | ^4.6.0   | 4.6.0     | 4.6.0   | current                       | Job scheduling               |
| `prom-client`                               | ^15.1.3  | 15.1.3    | 15.1.3  | current                       | Prometheus metrics           |
| `swagger-ui-express`                        | ^5.0.1   | 5.0.1     | 5.0.1   | current                       | API docs UI                  |
| `twilio`                                    | ^6.0.2   | 6.1.0     | 6.1.1   | non-breaking update available | WhatsApp/SMS                 |
| `winston`                                   | ^3.19.0  | 3.19.0    | 3.19.0  | current                       | Logging                      |
| `ws`                                        | ^8.21.3  | 8.21.3    | 8.22.0  | non-breaking update available | WebSocket streaming          |
| `zod`                                       | ^4.4.3   | 4.4.3     | 4.6.5   | non-breaking update available | Request validation           |

### Dev dependencies (25 direct)

| Package                            | Range     | Installed | Latest      | Status                        | Purpose          |
| ---------------------------------- | --------- | --------- | ----------- | ----------------------------- | ---------------- |
| `@aws-sdk/client-ssm`              | ^3.1120.0 | 3.1120.0  | 3.1141.0    | non-breaking update available | Secrets tooling  |
| `@redocly/cli`                     | ^2.34.0   | 2.49.0    | 2.54.3      | non-breaking update available | OpenAPI lint     |
| `@types/bcryptjs`                  | ^2.4.6    | 2.4.6     | 2.4.6       | current                       | Type definitions |
| `@types/cors`                      | ^2.8.17   | 2.8.19    | 2.8.19      | current                       | Type definitions |
| `@types/express`                   | ^4.17.21  | 4.17.25   | 5.0.6       | **breaking update available** | Type definitions |
| `@types/jest`                      | ^29.5.10  | 29.5.14   | 30.0.0      | **breaking update available** | Type definitions |
| `@types/js-yaml`                   | ^4.0.9    | 4.0.9     | 4.0.9       | current                       | Type definitions |
| `@types/jsonwebtoken`              | ^9.0.10   | 9.0.10    | 9.0.10      | current                       | Type definitions |
| `@types/node`                      | ^20.10.6  | 20.19.43  | 26.6.3      | **breaking update available** | Type definitions |
| `@types/node-cron`                 | ^3.0.11   | 3.0.11    | 3.0.11      | current                       | Type definitions |
| `@types/supertest`                 | ^7.2.1    | 7.2.1     | 7.2.1       | current                       | Type definitions |
| `@types/swagger-ui-express`        | ^4.1.8    | 4.1.8     | 4.1.8       | current                       | Type definitions |
| `@types/ws`                        | ^8.18.1   | 8.18.1    | 8.18.1      | current                       | Type definitions |
| `@typescript-eslint/eslint-plugin` | ^8.65.0   | 8.68.0    | 8.70.1      | non-breaking update available | Lint             |
| `@typescript-eslint/parser`        | ^8.65.0   | 8.68.0    | 8.70.1      | non-breaking update available | Lint             |
| `eslint`                           | ^8.57.0   | 8.57.1    | 10.11.0     | **breaking update available** | Lint             |
| `husky`                            | ^9.1.7    | 9.1.7     | 9.1.7       | current                       | Git hooks        |
| `jest`                             | ^29.7.0   | 29.7.0    | 30.5.2      | **breaking update available** | Tests            |
| `nodemon`                          | ^3.0.2    | 3.1.14    | 3.1.14      | current                       | Dev server       |
| `prettier`                         | ^3.1.1    | 3.9.6     | 3.9.9       | non-breaking update available | Formatting       |
| `prisma`                           | ^5.22.0   | 5.22.0    | 8.0.0-rc.17 | **breaking update available** | Migrations CLI   |
| `supertest`                        | ^6.3.3    | 6.3.4     | 7.3.0       | **breaking update available** | HTTP tests       |
| `ts-jest`                          | ^29.1.1   | 29.4.12   | 29.4.14     | non-breaking update available | Tests            |
| `ts-node`                          | ^10.9.2   | 10.9.2    | 10.9.2      | current                       | Dev runtime      |
| `typescript`                       | ^5.3.3    | 5.9.3     | 7.0.2       | **breaking update available** | Compiler         |
