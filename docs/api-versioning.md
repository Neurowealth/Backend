# API Versioning and Route Lifecycle Policy

## Overview

As the NeuroWealth Backend grows and evolves, a clear API versioning strategy ensures that API consumers (mobile apps, frontend clients, third-party integrations) can reliably integrate with our services without unexpected breaking changes. This policy defines:

- **How versions are introduced** — when and why we create new API versions
- **Versioning conventions** — URL patterns, route naming, and registration
- **Deprecation timelines** — how we announce, support, and retire old versions
- **Breaking change handling** — what constitutes a breaking change and how to manage it
- **Safe endpoint retirement** — steps to gracefully sunset API endpoints

All routes are versioned at the URL level using the pattern `/api/v{N}/resource`, where `N` is the major version number. This ensures that multiple versions can coexist in the same codebase during transition periods.

## Route Naming Standards

### URL Pattern

All API routes follow a consistent versioning structure:

```
/api/v{VERSION}/{RESOURCE}
```

**Components:**
- `api` — Static prefix indicating this is an API endpoint
- `v{N}` — Version number (v1, v2, v3, etc.). Starts at v1.
- `resource` — The resource being accessed (e.g., `auth`, `portfolio`, `transactions`)

### Examples

```
GET    /api/v1/auth/challenge       (GET a challenge)
POST   /api/v1/auth/verify          (Verify a Stellar signature)
POST   /api/v1/auth/logout          (Revoke the active session)
GET    /api/v1/portfolio/balance    (Fetch user portfolio balance)
GET    /api/v1/transactions/history (List transaction history)
```

### Current API State (v1)

All routes registered in `src/routes/` are served as **v1 endpoints** under the
`/api/v1/` prefix. The legacy unversioned `/api/` paths remain mounted as
**deprecated aliases** (see [Deprecation Headers](#deprecation-headers)) so existing
clients keep working during migration. The mounting is driven by the `apiRoutes`
table in `src/index.ts`, which mounts each resource under both `/api/v1/<resource>`
(primary) and `/api/<resource>` (deprecated). Every response carries an
`X-API-Version: 1` header.

The versioned resources are:

- `auth` — Authentication and session management
- `admin` — Administrative operations
- `agent` — AI agent interactions and queries
- `analytics` — Analytics and reporting
- `deposit` — Deposit operations
- `health` — Health checks and status
- `metrics` — Prometheus metrics
- `portfolio` — User portfolio data
- `protocols` — Protocol information
- `stellar` — Stellar blockchain operations
- `transactions` — Transaction history and details
- `vault` — Vault operations
- `whatsapp` — WhatsApp integration
- `withdraw` — Withdrawal operations

## Version Introduction Process

### When to Create a New Version

A new API version is created **only when a breaking change is necessary**. Breaking changes include:

**Breaking Changes (require version bump):**
- Removing a field from a response payload
- Changing a field's data type (e.g., `balance: number` → `balance: string`)
- Renaming an existing field
- Changing an endpoint's HTTP method (e.g., GET → POST)
- Changing HTTP status codes returned by an endpoint
- Adding a required request body field
- Removing authentication or changing auth requirements
- Changing the meaning or behavior of an existing parameter

**Non-Breaking Changes (do NOT require version bump):**
- Adding a new optional response field
- Adding a new optional request parameter or query string field
- Adding entirely new endpoints (new resources or sub-resources)
- Adding new HTTP methods on a resource (as long as existing methods are unchanged)
- Expanding error messages or adding new error codes

### Registering a New Versioned Route in Express

#### Single Route File with Multiple Versions

If you need to support both v1 and v2 of the same resource, register both in the same route file:

```typescript
// src/routes/portfolio.ts
import { Router } from 'express';
import { getBalanceV1, getBalanceV2 } from '../controllers/portfolio-controller';

const router = Router();

// v1 — Original balance endpoint
router.get('/v1/balance', getBalanceV1);

// v2 — Enhanced balance endpoint with additional fields
router.get('/v2/balance', getBalanceV2);

export default router;
```

Then in your main app file (`src/app.ts` or similar), mount all routes at `/api`:

```typescript
app.use('/api/portfolio', portfolioRouter);
```

This results in URLs like:
- `GET /api/portfolio/v1/balance`
- `GET /api/portfolio/v2/balance`

#### Separate Route Files for Each Version

For larger APIs with many version-specific changes, create separate files:

```typescript
// src/routes/v1/portfolio.ts
import { Router } from 'express';
import { getBalance as getBalanceV1 } from '../../controllers/portfolio-controller.v1';

const router = Router();
router.get('/balance', getBalanceV1);
export default router;

// src/routes/v2/portfolio.ts
import { Router } from 'express';
import { getBalance as getBalanceV2 } from '../../controllers/portfolio-controller.v2';

const router = Router();
router.get('/balance', getBalanceV2);
export default router;
```

Then mount both versions:

```typescript
app.use('/api/v1/portfolio', portfolioV1Router);
app.use('/api/v2/portfolio', portfolioV2Router);
```

### Deprecation Headers

When a route is deprecated but still active, include HTTP headers to inform API consumers:

```typescript
// Middleware to add deprecation headers
router.get('/v1/balance', (req, res, next) => {
  res.set('Deprecation', 'true');
  res.set('Sunset', 'Wed, 01 Jan 2025 00:00:00 GMT');
  res.set('Link', '</api/v2/balance>; rel="successor-version"');
  // Handle request
});
```

**Headers:**
- `Deprecation: true` — Indicates this version is deprecated
- `Sunset: <date>` — RFC 7231 date when this endpoint will be removed
- `Link: <url>; rel="successor-version"` — URL to the replacement endpoint (optional but recommended)

## Deprecation Policy

### Announcement Period

When a breaking change requires a new version, we announce the deprecation with at least **30 days advance notice**.

**Announcement steps:**
1. Document the breaking change in the project changelog (e.g., `CHANGELOG.md`)
2. Send an email notification to API consumers (if applicable)
3. Update API documentation with migration guide
4. Create a GitHub issue or discussion noting the sunset date
5. Add the deprecation headers to the old endpoint (see above)

**Example changelog entry:**

```markdown
## [2.0.0] - 2025-02-01

### Deprecated
- `/api/v1/portfolio/balance` — **deprecated**, use `/api/v2/portfolio/balance` instead.
  Sunset date: 2025-05-01. This endpoint will be removed in 90 days.
  
### New
- `/api/v2/portfolio/balance` — Enhanced balance endpoint with multi-currency support.
```

### Support Window

After a deprecation announcement, we maintain **both versions** for **90 days**. During this window:

- The old version (v1) remains fully functional and supported
- The new version (v2) is the recommended target
- Bug fixes are applied to both versions during the support window
- API consumers have time to migrate their integrations

### Sunset Timeline

After the 90-day support window expires, we perform a **hard removal**:

1. Remove the deprecated endpoint from the codebase
2. Remove the associated controller/business logic (if not reused by other endpoints)
3. Update API documentation to remove references
4. Update the changelog with removal notes

**Timeline Example:**
- **Day 0:** Announce deprecation with 30-day notice (e.g., 2024-11-01)
- **Day 30:** Deprecation window begins, v1 and v2 both active (2024-12-01)
- **Day 120:** Support window ends, removal date announced (2025-03-01)
- **Day 120+:** Remove v1 endpoints from production (2025-03-01 or later)

### Communication to API Consumers

**For public/external APIs:**
- Email notifications to registered API key holders
- Blog post or announcement on the website
- API status page notification
- Deprecation headers in all responses (as noted above)

**For internal/private APIs:**
- GitHub issue assigned to consuming teams
- Slack notification in relevant channels
- API documentation update with migration guide

## Breaking Change Handling

### What Counts as a Breaking Change

A breaking change is any modification that **existing client code cannot handle** without updating. Examples:

**Breaking:**
```javascript
// v1 response
{ "balance": 1000 }

// v2 response (type changed)
{ "balance": "1000" }  // ❌ Client expecting number breaks
```

**Breaking:**
```javascript
// v1 endpoint
POST /api/v1/auth/verify { publicKey, signature }

// v2 endpoint (renamed field)
POST /api/v2/auth/verify { publicKey, sig }  // ❌ Old clients send "signature"
```

**Breaking:**
```javascript
// v1 response
{ "transactionId": "abc123", "status": "pending" }

// v2 response (field removed)
{ "transactionId": "abc123" }  // ❌ Clients expecting "status" break
```

### What Does NOT Count as a Breaking Change

Non-breaking changes can be rolled out to existing versions without creating a new version:

**Non-breaking:**
```javascript
// v1 response
{ "balance": 1000 }

// Upgraded v1 response (added optional field)
{ "balance": 1000, "availableBalance": 950 }  // ✅ Existing clients ignore new field
```

**Non-breaking:**
```javascript
// v1 endpoint
GET /api/v1/transactions

// Upgraded v1 endpoint (added optional query param)
GET /api/v1/transactions?limit=10  // ✅ Old URLs still work
```

**Non-breaking:**
```javascript
// v1 response structure
{ "id": "123", "amount": 100 }

// New v1 endpoint (new resource)
GET /api/v1/transfers  // ✅ Doesn't modify existing endpoints
```

### Process for Breaking Changes

When a breaking change is necessary:

1. **Plan the change** — Identify which fields/behaviors will change
2. **Announce early** — Notify consumers 30+ days before the change takes effect
3. **Create new version** — Implement the new version alongside the old one
4. **Support both** — Keep v1 and v2 active during the 90-day window
5. **Document migration** — Provide clear examples of v1 → v2 migration
6. **Sunset old version** — Remove v1 after the support window expires

**Example: Renaming "balance" to "currentBalance"**

```typescript
// src/routes/portfolio.ts

import { Router } from 'express';
import { getBalanceV1, getBalanceV2 } from '../controllers/portfolio-controller';

const router = Router();

// v1 — Original API (deprecated)
router.get('/v1/balance', (req, res, next) => {
  res.set('Deprecation', 'true');
  res.set('Sunset', 'Wed, 01 Apr 2025 00:00:00 GMT');
  next();
}, getBalanceV1);

// v2 — New API with renamed field
router.get('/v2/balance', getBalanceV2);

export default router;
```

## Safe Endpoint Retirement

### Retirement Checklist

Before removing a deprecated endpoint, verify:

- [ ] Endpoint has been deprecated for at least 90 days
- [ ] Sunset date has passed
- [ ] Changelog documents the deprecation and removal
- [ ] Replacement endpoint exists and is documented
- [ ] All internal services have migrated to the new version
- [ ] No active monitoring dashboards reference the old endpoint
- [ ] Error logs show minimal traffic to the old endpoint

### Retirement Steps

1. **Final announcement** — Send one last notice to any remaining users
2. **Remove the route handler** — Delete the route definition from `src/routes/`
3. **Remove the controller** — Delete the associated controller method if not reused
4. **Remove tests** — Delete unit tests for the deprecated endpoint
5. **Update documentation** — Remove from API docs, update README
6. **Update changelog** — Add removal notes with date
7. **Create removal commit** — Use clear commit message: `refactor(api): remove deprecated v1/balance endpoint`
8. **Deploy to production** — Merge and deploy the removal

### Handling Remaining Traffic to Retired Endpoints

If traffic to a retired endpoint is detected after removal, two strategies are available:

#### Strategy 1: Redirect (Soft Deprecation)

Redirect old URLs to new ones with an HTTP 301 (permanent) or 307 (temporary) status:

```typescript
router.get('/v1/balance', (req, res) => {
  res.redirect(301, '/api/v2/balance');
});
```

This allows old clients to continue working without modification, though they will receive an extra HTTP hop.

#### Strategy 2: Return Error (Hard Removal)

Return a 410 Gone or 404 Not Found status immediately:

```typescript
router.get('/v1/balance', (req, res) => {
  res.status(410).json({
    error: 'Endpoint Retired',
    message: 'This endpoint was removed on 2025-03-01. Please migrate to /api/v2/balance.',
    successor: '/api/v2/balance',
  });
});
```

Hard removal forces clients to upgrade but is cleaner from an API surface perspective.

## Implementation Examples

### Example 1: Adding a New Required Field (Breaking Change)

**Scenario:** The auth/verify endpoint needs to require a `chainId` field for multi-chain support.

**v1 (old):**
```typescript
// POST /api/v1/auth/verify
// Request: { publicKey: string, signature: string }
// Response: { token: string, userId: string }
```

**v2 (new):**
```typescript
// POST /api/v2/auth/verify
// Request: { publicKey: string, signature: string, chainId: string }
// Response: { token: string, userId: string, chainId: string }
```

**Implementation:**

```typescript
// src/controllers/auth-controller.ts

export const verifyV1 = async (req: Request, res: Response) => {
  const { publicKey, signature } = req.body;
  // Assume Stellar mainnet (chainId = 'stellar-mainnet')
  const result = await verifySignature(publicKey, signature, 'stellar-mainnet');
  res.json({ token: result.token, userId: result.userId });
};

export const verifyV2 = async (req: Request, res: Response) => {
  const { publicKey, signature, chainId } = req.body;
  const result = await verifySignature(publicKey, signature, chainId);
  res.json({ token: result.token, userId: result.userId, chainId });
};
```

**Route registration:**

```typescript
// src/routes/auth.ts
import { Router } from 'express';
import { verifyV1, verifyV2, challenge, logout } from '../controllers/auth-controller';
import { validate } from '../middleware/validate';
import { authChallengeSchema, authVerifySchemaV1, authVerifySchemaV2 } from '../validators/auth-validators';
import { requireAuth } from '../middleware/authenticate';

const router = Router();

router.post('/v1/challenge', validate({ body: authChallengeSchema }), challenge);
router.post('/v1/verify', validate({ body: authVerifySchemaV1 }), verifyV1);
router.post('/v1/logout', requireAuth, logout);

router.post('/v2/challenge', validate({ body: authChallengeSchema }), challenge);
router.post('/v2/verify', validate({ body: authVerifySchemaV2 }), (req, res, next) => {
  // Deprecation headers omitted for v2 since it's the current version
  next();
}, verifyV2);
router.post('/v2/logout', requireAuth, logout);

export default router;
```

### Example 2: Removing a Field (Breaking Change)

**Scenario:** Remove the deprecated `legacyUserId` field from the portfolio response.

**v1 (old):**
```json
{
  "userId": "user-123",
  "legacyUserId": "old-123",
  "balance": 1000,
  "assets": [...]
}
```

**v2 (new):**
```json
{
  "userId": "user-123",
  "balance": 1000,
  "assets": [...]
}
```

**Controllers:**

```typescript
// src/controllers/portfolio-controller.ts

export const getPortfolioV1 = async (req: Request, res: Response) => {
  const portfolio = await fetchPortfolio(req.user.id);
  res.json({
    userId: portfolio.userId,
    legacyUserId: portfolio.legacyId,  // Keep for v1 compatibility
    balance: portfolio.balance,
    assets: portfolio.assets,
  });
};

export const getPortfolioV2 = async (req: Request, res: Response) => {
  const portfolio = await fetchPortfolio(req.user.id);
  res.json({
    userId: portfolio.userId,
    balance: portfolio.balance,
    assets: portfolio.assets,
  });
};
```

## Monitoring Deprecation

To track API usage and plan retirement dates:

1. **Log all requests** — Ensure your logging captures request paths and versions
2. **Query request volume** — Identify v1 vs v2 usage over time
3. **Set metrics** — Track endpoint hit counts by version
4. **Alert on stale traffic** — If v1 traffic continues beyond sunset date, investigate
5. **Publish usage reports** — Share deprecation timelines with consumers monthly

Example metrics query (if using Prometheus):

```
rate(http_requests_total{endpoint=~"/api/v1/.*"}[7d])
rate(http_requests_total{endpoint=~"/api/v2/.*"}[7d])
```

## FAQ

**Q: Can we deprecate a route without creating a new version?**

A: Only if the change is non-breaking (e.g., adding optional fields). For breaking changes, always create a new version first.

**Q: How long should we keep old versions?**

A: The standard is 90 days of active support after deprecation announcement. After that, removal is acceptable. You can extend if data suggests high usage.

**Q: What if a consumer doesn't migrate before sunset?**

A: Their requests will return 404 or 410 (depending on your strategy). We recommend a 30-day notice before hard removal and offering redirects to the new endpoint.

**Q: Can multiple versions share controller logic?**

A: Yes. If the business logic is identical and only the response format differs, both versions can call the same controller and format the output accordingly.

**Q: Should we version the database schema?**

A: No. Database schemas remain unversioned. Controllers are responsible for mapping database rows to the appropriate API response format.

## Summary

- **Version only on breaking changes** — don't version non-breaking updates
- **Use `/api/v{N}/resource` pattern** — all versioned routes follow this structure
- **Announce 30 days ahead** — give consumers time to prepare
- **Support for 90 days** — both versions run in parallel
- **Hard sunset after window** — remove completely or redirect
- **Document thoroughly** — changelog, headers, and migration guides are essential

