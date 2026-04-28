# API Reference

Comprehensive reference for all backend endpoints defined in src/routes.

## Base Information

- Base URL (local): http://localhost:3001
- Content type: application/json unless otherwise specified
- Auth header format: Authorization: Bearer <token>

## Authentication and Authorization

- Public endpoints: GET /health, POST /api/auth/challenge, POST /api/auth/verify, GET /api/whatsapp/webhook, POST /api/whatsapp/webhook, GET /api/vault/state, GET /api/protocols/rates, GET /api/protocols/agent/status, GET /api/agent/status
- Session auth endpoints: endpoints guarded by requireAuth require a valid live session token and reject missing, expired, or inactive sessions with 401 Unauthorized.
- User-scope endpoints: endpoints guarded by enforceUserAccess require the requested userId to match the authenticated userId.
- JWT middleware endpoint: POST /api/auth/logout uses AuthMiddleware.validateJwt and may return 401 with specific JWT/session errors.
- Twilio webhook auth: POST /api/whatsapp/webhook requires x-twilio-signature and TWILIO_AUTH_TOKEN; in production, invalid signatures are rejected with 403 Forbidden.

## Common Error Response Shapes

- Validation errors (zod):
  {
  "error": "Validation error",
  "details": {
  "formErrors": [],
  "fieldErrors": {
  "fieldName": ["error message"]
  }
  }
  }
- Unauthorized:
  {
  "error": "Unauthorized"
  }
- Not found:
  {
  "error": "<resource-specific message>"
  }

---

## Health

### GET /health

- Auth: none
- Description: Service health check.
- Request params: none
- Request body: none

Response 200:
{
"status": "ok",
"timestamp": "2026-04-26T14:45:00.000Z",
"version": "1.0.0",
"environment": "development"
}

---

## Agent

### GET /api/agent/status

- Auth: none
- Description: Returns runtime health and scheduling status for the agent loop.
- Request params: none
- Request body: none

Response 200:
{
"success": true,
"data": {
"isRunning": true,
"lastRebalanceAt": "2026-04-26T13:00:00.000Z",
"currentProtocol": "Blend",
"currentApy": "1.25",
"nextScheduledCheck": "2026-04-26T15:00:00.000Z",
"lastError": null,
"healthStatus": "healthy",
"timestamp": "2026-04-26T14:45:00.000Z"
}
}

Response 500:
{
"success": false,
"error": "Unknown error"
}

---

## Auth

### POST /api/auth/challenge

- Auth: none
- Description: Creates a one-time nonce for Stellar signature verification.
- Request params: none
- Request body schema:
  {
  "stellarPubKey": "string"
  }

Example request:
{
"stellarPubKey": "GABCD1234EXAMPLEPUBLICKEY"
}

Response 200:
{
"nonce": "nw-auth-<random-hex>",
"expiresAt": "2026-04-26T14:50:00.000Z"
}

Response 400:
{
"error": "stellarPubKey is required"
}

Response 400 (invalid key):
{
"error": "Invalid Stellar public key"
}

### POST /api/auth/verify

- Auth: none
- Description: Verifies signature over nonce, upserts user, creates session, returns token.
- Request params: none
- Request body schema:
  {
  "stellarPubKey": "string",
  "signature": "string"
  }

Example request:
{
"stellarPubKey": "GABCD1234EXAMPLEPUBLICKEY",
"signature": "base64-signature"
}

Response 200:
{
"token": "jwt-token",
"userId": "550e8400-e29b-41d4-a716-446655440004",
"expiresAt": "2026-04-27T14:45:00.000Z"
}

Response 400:
{
"error": "stellarPubKey and signature are required"
}

Response 401 examples:
{
"error": "No active challenge for this public key"
}
{
"error": "Challenge nonce has expired"
}
{
"error": "Invalid signature"
}

Response 500:
{
"error": "Internal server error"
}

### POST /api/auth/logout

- Auth: required (Authorization Bearer token validated via AuthMiddleware.validateJwt)
- Description: Revokes current session token.
- Request params: none
- Request body: none

Example request headers:
Authorization: Bearer <token>

Response 200:
{
"message": "Logged out successfully"
}

Response 401 examples (from middleware):
{
"error": "No token provided"
}
{
"error": "Invalid Bearer token"
}
{
"error": "Invalid token"
}
{
"error": "Session not found"
}
{
"error": "Session expired"
}

Response 500:
{
"error": "Internal server error"
}

---

## WhatsApp

### GET /api/whatsapp/webhook

- Auth: none
- Description: Twilio webhook liveness check.
- Request params: none
- Request body: none

Response 200 (text/plain):
WhatsApp webhook is alive

### POST /api/whatsapp/webhook

- Auth: Twilio signature validation
- Description: Receives incoming WhatsApp messages and returns TwiML response XML.
- Required header: x-twilio-signature
- Required environment: TWILIO_AUTH_TOKEN
- Request body (Twilio form payload, common fields):
  {
  "From": "whatsapp:+15550001234",
  "Body": "balance"
  }

Response 200 (text/xml):
<Response>
<Message>Your formatted assistant reply</Message>
</Response>

Response 403:
Forbidden

Notes:

- In production, invalid signatures are rejected.
- In non-production, invalid signatures may be tolerated for local testing if signature and auth token are present.

---

## Portfolio

### GET /api/portfolio/:userId

- Auth: required (requireAuth + enforceUserAccess)
- Path params:
  - userId: uuid string
- Query params: none
- Request body: none

Response 200:
{
"userId": "550e8400-e29b-41d4-a716-446655440001",
"totalBalance": 8200,
"totalEarnings": 300,
"activePositions": 1,
"positions": [
{
"id": "pos-1",
"protocolName": "Blend",
"assetSymbol": "USDC",
"currentValue": 5200,
"yieldEarned": 200,
"status": "ACTIVE"
}
],
"whatsappReply": "..."
}

Response 401:
{
"error": "Unauthorized"
}

Response 404:
{
"error": "User not found"
}

### GET /api/portfolio/:userId/history

- Auth: required (requireAuth + enforceUserAccess)
- Path params:
  - userId: uuid string
- Query params:
  - period: enum(7d, 30d, 90d), default 30d
- Request body: none

Example request:
GET /api/portfolio/550e8400-e29b-41d4-a716-446655440001/history?period=30d

Response 200:
{
"userId": "550e8400-e29b-41d4-a716-446655440001",
"period": "30d",
"points": [
{
"date": "2026-04-25",
"yieldAmount": 5
}
],
"whatsappReply": "..."
}

Response 400:
{
"error": "Validation error",
"details": {
"formErrors": [],
"fieldErrors": {
"period": ["Invalid option"]
}
}
}

Response 401:
{
"error": "Unauthorized"
}

Response 404:
{
"error": "User not found"
}

### GET /api/portfolio/:userId/earnings

- Auth: required (requireAuth + enforceUserAccess)
- Path params:
  - userId: uuid string
- Query params: none
- Request body: none

Response 200:
{
"userId": "550e8400-e29b-41d4-a716-446655440001",
"totalEarnings": 300,
"periodEarnings": 18,
"averageApy": 4.025,
"whatsappReply": "..."
}

Response 401:
{
"error": "Unauthorized"
}

Response 404:
{
"error": "User not found"
}

---

## Transactions

### GET /api/transactions/detail/:txHash

- Auth: required (requireAuth)
- Path params:
  - txHash: string
- Query params: none
- Request body: none

Response 200:
{
"transaction": {
"id": "tx-id-1",
"txHash": "txhash-abc001",
"type": "DEPOSIT",
"status": "CONFIRMED",
"amount": 100,
"assetSymbol": "USDC",
"protocolName": "Blend",
"createdAt": "2026-04-26T14:00:00.000Z"
},
"whatsappReply": "..."
}

Response 401:
{
"error": "Unauthorized"
}

Response 404:
{
"error": "Transaction not found"
}

### GET /api/transactions/:userId

- Auth: required (requireAuth + enforceUserAccess)
- Path params:
  - userId: uuid string
- Query params:
  - page: int >= 1, default 1
  - limit: int between 1 and 50, default 5
- Request body: none

Example request:
GET /api/transactions/550e8400-e29b-41d4-a716-446655440002?page=2&limit=10

Response 200:
{
"page": 2,
"limit": 10,
"total": 20,
"transactions": [
{
"id": "tx-id-1",
"txHash": "txhash-abc001",
"type": "DEPOSIT",
"status": "CONFIRMED",
"amount": 100,
"assetSymbol": "USDC",
"protocolName": "Blend",
"createdAt": "2026-04-26T14:00:00.000Z"
}
],
"whatsappReply": "..."
}

Response 400:
{
"error": "Validation error",
"details": {
"formErrors": [],
"fieldErrors": {
"page": ["Invalid input"]
}
}
}

Response 401:
{
"error": "Unauthorized"
}

Response 404:
{
"error": "User not found"
}

---

## Protocols

### GET /api/protocols/rates

- Auth: none
- Description: Returns the latest 10 protocol rates.
- Request params: none
- Request body: none

Response 200:
{
"rates": [
{
"protocolName": "Blend",
"assetSymbol": "USDC",
"supplyApy": 8.75,
"borrowApy": 4.1,
"tvl": 1200000,
"network": "TESTNET",
"fetchedAt": "2026-04-26T14:00:00.000Z"
}
],
"whatsappReply": "..."
}

### GET /api/protocols/agent/status

- Auth: none
- Description: Returns latest persisted agent status record.
- Request params: none
- Request body: none

Response 200:
{
"status": "SUCCESS",
"action": "ANALYZE",
"updatedAt": "2026-04-26T14:00:00.000Z",
"whatsappReply": "..."
}

Response 404:
{
"error": "Agent status not found"
}

---

## Deposit

### POST /api/deposit

- Auth: required (requireAuth)
- Description: Executes an on-chain deposit and persists transaction.
- Request params: none
- Request body schema:
  {
  "userId": "uuid",
  "amount": "number > 0",
  "assetSymbol": "string",
  "protocolName": "string (optional)",
  "memo": "string <= 280 chars (optional)"
  }

Example request:
{
"userId": "550e8400-e29b-41d4-a716-446655440003",
"amount": 100,
"assetSymbol": "USDC",
"protocolName": "Blend",
"memo": "monthly deposit"
}

Response 201:
{
"txHash": "chain-hash-0000000001",
"status": "CONFIRMED",
"transaction": {
"id": "tx-new",
"txHash": "chain-hash-0000000001",
"status": "CONFIRMED",
"amount": 100,
"assetSymbol": "USDC",
"protocolName": "Blend"
},
"whatsappReply": "..."
}

Response 400:
{
"error": "Validation error",
"details": {
"formErrors": [],
"fieldErrors": {
"amount": ["Too small: expected number to be >0"]
}
}
}

Response 401:
{
"error": "Unauthorized"
}

Response 404:
{
"error": "User not found"
}

Response 409:
{
"error": "Duplicate transaction hash"
}

---

## Withdraw

### POST /api/withdraw

- Auth: required (requireAuth)
- Description: Executes an on-chain withdrawal and persists transaction.
- Request params: none
- Request body schema:
  {
  "userId": "uuid",
  "amount": "number > 0",
  "assetSymbol": "string",
  "protocolName": "string (optional)",
  "memo": "string <= 280 chars (optional)"
  }

Example request:
{
"userId": "550e8400-e29b-41d4-a716-446655440004",
"amount": 50,
"assetSymbol": "USDC",
"protocolName": "Blend",
"memo": "withdraw to wallet"
}

Response 201:
{
"txHash": "withdraw-hash-0001",
"status": "CONFIRMED",
"transaction": {
"id": "withdraw-tx-new",
"txHash": "withdraw-hash-0001",
"status": "CONFIRMED",
"amount": 50,
"assetSymbol": "USDC",
"protocolName": "Blend"
},
"whatsappReply": "..."
}

Response 400:
{
"error": "Validation error",
"details": {
"formErrors": [],
"fieldErrors": {
"amount": ["Too small: expected number to be >0"]
}
}
}

Response 401:
{
"error": "Unauthorized"
}

Response 404:
{
"error": "User not found"
}

Response 409:
{
"error": "Duplicate transaction hash"
}

---

## Vault

### GET /api/vault/state

- Auth: none
- Description: Returns current on-chain APY and active protocol.
- Request params: none
- Request body: none

Response 200:
{
"apy": 8.75,
"activeProtocol": "Blend"
}

### GET /api/vault/balance

- Auth: required (requireAuth)
- Description: Returns authenticated user on-chain vault balance and shares.
- Request params: none
- Request body: none

Response 200:
{
"balance": 1500.25,
"shares": 1450.1
}

Response 401:
{
"error": "Unauthorized"
}

Response 404:
{
"error": "User not found"
}

---

## Endpoint Coverage Checklist (src/routes)

- health.ts: GET /health
- agent.ts: GET /api/agent/status
- auth.ts: POST /api/auth/challenge, POST /api/auth/verify, POST /api/auth/logout
- whatsapp.ts: GET /api/whatsapp/webhook, POST /api/whatsapp/webhook
- portfolio.ts: GET /api/portfolio/:userId, GET /api/portfolio/:userId/history, GET /api/portfolio/:userId/earnings
- transactions.ts: GET /api/transactions/detail/:txHash, GET /api/transactions/:userId
- protocols.ts: GET /api/protocols/rates, GET /api/protocols/agent/status
- deposit.ts: POST /api/deposit
- withdraw.ts: POST /api/withdraw
- vault.ts: GET /api/vault/state, GET /api/vault/balance
