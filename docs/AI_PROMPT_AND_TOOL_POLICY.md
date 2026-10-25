# AI Prompt and Tool Invocation Policy

## Overview

This document defines safe defaults and constraints around AI prompts, tool usage, and external calls to ensure the agent cannot act beyond approved boundaries. The policy reduces unsafe or unintended automation, improves auditability of agent decisions, and clarifies operational guardrails.

## Core Principles

1. **Explicit Approval Required**: High-risk actions require explicit gating and approval
2. **Fail-Safe Defaults**: Default to safe, conservative behavior
3. **Audit Trail**: All agent decisions and tool invocations are logged
4. **Human-in-the-Loop**: Critical financial actions require human confirmation
5. **Bounded Autonomy**: Agent operates within well-defined constraints

## Prompt Policy

### Safe Prompt Defaults

#### System Prompt Template

```typescript
const SYSTEM_PROMPT = `
You are a financial assistant for NeuroWealth, a cryptocurrency portfolio management platform.
Your role is to help users understand their portfolio, make informed decisions, and execute
actions only when explicitly authorized.

CORE CONSTRAINTS:
- You can only suggest actions, never execute them without user confirmation
- You must never reveal private keys, seed phrases, or sensitive authentication data
- You must never suggest actions that would bypass security controls
- You must always explain the risks of any suggested action
- You must never make guarantees about investment returns or performance

ALLOWED ACTIONS:
- Read portfolio data
- Explain portfolio composition
- Suggest rebalancing strategies (with risk warnings)
- Answer questions about yield protocols
- Explain transaction history

PROHIBITED ACTIONS:
- Execute transactions without explicit user approval
- Reveal or suggest private key operations
- Bypass rate limits or security controls
- Make unauthorized API calls
- Access other users' data
- Modify system configuration

RISK ASSESSMENT:
For any action that moves funds, you must:
1. Explain the action in clear, non-technical language
2. List all associated risks
3. Provide the exact amounts and destinations
4. Require explicit user confirmation
5. Log the decision with full context
`
```

### Prompt Constraints

#### Input Validation

```typescript
interface PromptConstraints {
  maxTokens: number
  maxToolCallsPerTurn: number
  allowedTools: string[]
  prohibitedPatterns: RegExp[]
  requireConfirmationFor: string[]
}

const DEFAULT_CONSTRAINTS: PromptConstraints = {
  maxTokens: 4096,
  maxToolCallsPerTurn: 5,
  allowedTools: [
    'get_portfolio',
    'get_positions',
    'get_protocol_rates',
    'calculate_rebalance',
    'explain_strategy',
  ],
  prohibitedPatterns: [
    /private[_\s]?key/i,
    /seed[_\s]?phrase/i,
    /secret/i,
    /password/i,
    /bypass/i,
    /override/i,
  ],
  requireConfirmationFor: [
    'execute_transaction',
    'withdraw',
    'transfer',
    'approve',
    'sign',
  ],
}
```

#### Output Sanitization

```typescript
function sanitizePromptOutput(output: string): string {
  // Remove any potential private key patterns
  let sanitized = output.replace(/S[A-Za-z0-9]{55}/g, '[REDACTED_PRIVATE_KEY]')
  
  // Remove seed phrase patterns
  sanitized = sanitized.replace(/\b(\w+\s+){11}\w+\b/g, '[REDACTED_SEED_PHRASE]')
  
  // Remove API keys
  sanitized = sanitized.replace(/\b[A-Za-z0-9]{32,}\b/g, '[REDACTED_API_KEY]')
  
  // Remove any instructions to bypass controls
  sanitized = sanitized.replace(/bypass|override|ignore.*security/gi, '[REDACTED_INSTRUCTION]')
  
  return sanitized
}
```

## Tool Invocation Policy

### Tool Classification

#### Safe Tools (No Approval Required)

| Tool | Description | Risk Level | Approval Required |
|------|-------------|------------|-------------------|
| `get_portfolio` | Read user portfolio data | Low | No |
| `get_positions` | Read user positions | Low | No |
| `get_protocol_rates` | Read protocol APY rates | Low | No |
| `explain_strategy` | Explain investment strategy | Low | No |
| `calculate_rebalance` | Calculate rebalance suggestion | Medium | No (read-only) |

#### Medium-Risk Tools (Confirmation Required)

| Tool | Description | Risk Level | Approval Required |
|------|-------------|------------|-------------------|
| `suggest_rebalance` | Suggest portfolio rebalance | Medium | Yes |
| `analyze_risk` | Analyze portfolio risk | Medium | No (read-only) |
| `estimate_gas` | Estimate transaction gas | Low | No |

#### High-Risk Tools (Explicit Approval Required)

| Tool | Description | Risk Level | Approval Required |
|------|-------------|------------|-------------------|
| `execute_transaction` | Execute on-chain transaction | Critical | Yes (2FA) |
| `withdraw` | Withdraw funds to external address | Critical | Yes (2FA) |
| `transfer` | Transfer between accounts | Critical | Yes (2FA) |
| `approve` | Approve token spending | Critical | Yes (2FA) |
| `sign_message` | Sign arbitrary message | High | Yes (2FA) |

### Tool Invocation Guardrails

#### Pre-Invocation Checks

```typescript
interface ToolInvocationGuard {
  toolName: string
  userId: string
  parameters: Record<string, unknown>
}

async function checkToolInvocation(guard: ToolInvocationGuard): Promise<{
  allowed: boolean
  reason?: string
  requiresApproval: boolean
}> {
  const { toolName, userId, parameters } = guard

  // Check if tool is allowed
  if (!DEFAULT_CONSTRAINTS.allowedTools.includes(toolName) && 
      !HIGH_RISK_TOOLS.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool ${toolName} is not in the allowed list`,
      requiresApproval: false,
    }
  }

  // Check if tool requires approval
  if (HIGH_RISK_TOOLS.includes(toolName)) {
    return {
      allowed: true,
      requiresApproval: true,
    }
  }

  // Check for prohibited patterns in parameters
  const paramStr = JSON.stringify(parameters)
  for (const pattern of DEFAULT_CONSTRAINTS.prohibitedPatterns) {
    if (pattern.test(paramStr)) {
      return {
        allowed: false,
        reason: 'Prohibited pattern detected in parameters',
        requiresApproval: false,
      }
    }
  }

  // Check user permissions
  const user = await db.user.findUnique({ where: { id: userId } })
  if (!user) {
    return {
      allowed: false,
      reason: 'User not found',
      requiresApproval: false,
    }
  }

  // Check if user has 2FA enabled for high-risk tools
  if (HIGH_RISK_TOOLS.includes(toolName) && !user.twoFactorEnabled) {
    return {
      allowed: false,
      reason: '2FA must be enabled for this action',
      requiresApproval: true,
    }
  }

  return {
    allowed: true,
    requiresApproval: false,
  }
}

const HIGH_RISK_TOOLS = [
  'execute_transaction',
  'withdraw',
  'transfer',
  'approve',
  'sign_message',
]
```

#### Post-Invocation Logging

```typescript
async function logToolInvocation(
  toolName: string,
  userId: string,
  parameters: Record<string, unknown>,
  result: unknown,
  durationMs: number,
  approved: boolean
): Promise<void> {
  await db.agentToolInvocation.create({
    data: {
      toolName,
      userId,
      parameters: sanitizeParameters(parameters),
      result: sanitizeResult(result),
      durationMs,
      approved,
      timestamp: new Date(),
    },
  })
}

function sanitizeParameters(params: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      sanitized[key] = redactSensitive(value)
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeParameters(value as Record<string, unknown>)
    } else {
      sanitized[key] = value
    }
  }
  return sanitized
}
```

## External Call Policy

### Allowed External Services

| Service | Purpose | Rate Limit | Authentication |
|---------|---------|------------|----------------|
| Stellar RPC | On-chain data | 100 req/min | API key |
| Protocol APIs | APY rates | 50 req/min | API key |
| Anthropic API | AI inference | 100 req/day | API key |
| Fee Oracle | Fee data | 10 req/min | Internal |

### External Call Guardrails

#### Call Validation

```typescript
interface ExternalCallGuard {
  service: string
  endpoint: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  userId?: string
}

async function validateExternalCall(guard: ExternalCallGuard): Promise<{
  allowed: boolean
  reason?: string
}> {
  const { service, endpoint, method, userId } = guard

  // Check if service is allowed
  const allowedServices = ['stellar_rpc', 'protocol_api', 'anthropic', 'fee_oracle']
  if (!allowedServices.includes(service)) {
    return {
      allowed: false,
      reason: `Service ${service} is not allowed`,
    }
  }

  // Check if endpoint is whitelisted
  const whitelistedEndpoints = getWhitelistedEndpoints(service)
  if (!whitelistedEndpoints.some(pattern => endpoint.match(pattern))) {
    return {
      allowed: false,
      reason: `Endpoint ${endpoint} is not whitelisted for ${service}`,
    }
  }

  // Check method constraints
  const allowedMethods = ['GET', 'POST']
  if (!allowedMethods.includes(method)) {
    return {
      allowed: false,
      reason: `Method ${method} is not allowed`,
    }
  }

  // Check rate limits
  const rateLimitKey = `${service}:${userId || 'anonymous'}`
  const currentUsage = await getRateLimitUsage(rateLimitKey)
  const limit = getRateLimit(service)
  if (currentUsage >= limit) {
    return {
      allowed: false,
      reason: 'Rate limit exceeded',
    }
  }

  return {
    allowed: true,
  }
}
```

#### Timeout and Retry Policy

```typescript
interface ExternalCallConfig {
  timeoutMs: number
  maxRetries: number
  backoffBaseMs: number
  backoffMaxMs: number
}

const EXTERNAL_CALL_CONFIGS: Record<string, ExternalCallConfig> = {
  stellar_rpc: {
    timeoutMs: 10000,
    maxRetries: 3,
    backoffBaseMs: 200,
    backoffMaxMs: 5000,
  },
  protocol_api: {
    timeoutMs: 5000,
    maxRetries: 2,
    backoffBaseMs: 100,
    backoffMaxMs: 2000,
  },
  anthropic: {
    timeoutMs: 30000,
    maxRetries: 1,
    backoffBaseMs: 1000,
    backoffMaxMs: 5000,
  },
  fee_oracle: {
    timeoutMs: 2000,
    maxRetries: 3,
    backoffBaseMs: 100,
    backoffMaxMs: 1000,
  },
}
```

## Failure and Fallback Paths

### Prompt Failure Handling

```typescript
async function executePromptWithFallback(
  prompt: string,
  userId: string
): Promise<string> {
  try {
    // Try AI model first
    const result = await callAnthropicAPI(prompt)
    return sanitizePromptOutput(result)
  } catch (error) {
    // Fallback to rule-based parser
    logger.warn('AI prompt failed, falling back to rule-based parser', {
      error: error.message,
      userId,
    })

    const fallbackResult = await executeRuleBasedParser(prompt)
    return fallbackResult
  }
}
```

### Tool Failure Handling

```typescript
async function executeToolWithFallback(
  toolName: string,
  parameters: Record<string, unknown>,
  userId: string
): Promise<unknown> {
  try {
    // Check guardrails
    const guard = await checkToolInvocation({ toolName, userId, parameters })
    if (!guard.allowed) {
      throw new Error(`Tool invocation not allowed: ${guard.reason}`)
    }

    // Execute tool
    const result = await executeTool(toolName, parameters)
    
    // Log success
    await logToolInvocation(toolName, userId, parameters, result, 0, true)
    
    return result
  } catch (error) {
    // Log failure
    await logToolInvocation(toolName, userId, parameters, null, 0, false)

    // Provide user-friendly error
    const userMessage = getUserFriendlyErrorMessage(toolName, error)
    
    // Suggest alternative actions
    const alternatives = getAlternativeActions(toolName)
    
    return {
      error: userMessage,
      alternatives,
    }
  }
}
```

### External Call Failure Handling

```typescript
async function executeExternalCallWithFallback(
  service: string,
  endpoint: string,
  method: string,
  body?: unknown
): Promise<unknown> {
  const config = EXTERNAL_CALL_CONFIGS[service]
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const result = await executeExternalCall(service, endpoint, method, body, config.timeoutMs)
      return result
    } catch (error) {
      lastError = error
      
      if (attempt < config.maxRetries) {
        const backoffMs = Math.min(
          config.backoffBaseMs * Math.pow(2, attempt),
          config.backoffMaxMs
        )
        await sleep(backoffMs)
      }
    }
  }

  // All retries exhausted, use fallback if available
  const fallback = getFallbackData(service, endpoint)
  if (fallback) {
    logger.warn(`External call failed, using fallback data`, {
      service,
      endpoint,
      error: lastError?.message,
    })
    return fallback
  }

  throw new Error(`External call failed after ${config.maxRetries} retries: ${lastError?.message}`)
}
```

## Configuration

### Environment Variables

```env
# AI Assistant Configuration
ASSISTANT_ENABLED=true
ASSISTANT_MODEL=claude-sonnet-4-5
ASSISTANT_MAX_TOKENS=4096
ASSISTANT_MAX_TOOL_CALLS_PER_TURN=5
ASSISTANT_PER_USER_TOKEN_BUDGET=20000
ASSISTANT_GLOBAL_TOKEN_BUDGET=2000000

# Tool Invocation
TOOL_EXECUTION_TIMEOUT_MS=30000
TOOL_MAX_RETRIES=3
TOOL_REQUIRE_2FA_FOR_HIGH_RISK=true

# External Call Limits
STELLAR_RPC_RATE_LIMIT=100
PROTOCOL_API_RATE_LIMIT=50
ANTHROPIC_API_RATE_LIMIT=100
FEE_ORACLE_RATE_LIMIT=10

# Fallback Configuration
FALLBACK_TO_RULE_BASED=true
FALLBACK_DATA_TTL_MS=300000
```

## Testing

### Unit Tests

```typescript
describe('Tool Invocation Guardrails', () => {
  it('should block prohibited tools', async () => {
    const result = await checkToolInvocation({
      toolName: 'unauthorized_tool',
      userId: 'user_123',
      parameters: {},
    })
    expect(result.allowed).toBe(false)
  })

  it('should require approval for high-risk tools', async () => {
    const result = await checkToolInvocation({
      toolName: 'execute_transaction',
      userId: 'user_123',
      parameters: {},
    })
    expect(result.requiresApproval).toBe(true)
  })

  it('should detect prohibited patterns', async () => {
    const result = await checkToolInvocation({
      toolName: 'get_portfolio',
      userId: 'user_123',
      parameters: { privateKey: 'S...' },
    })
    expect(result.allowed).toBe(false)
  })
})

describe('Prompt Sanitization', () => {
  it('should redact private keys', () => {
    const output = 'Your private key is SABC123...'
    const sanitized = sanitizePromptOutput(output)
    expect(sanitized).toContain('[REDACTED_PRIVATE_KEY]')
  })

  it('should redact seed phrases', () => {
    const output = 'Your seed phrase is word1 word2 word3...'
    const sanitized = sanitizePromptOutput(output)
    expect(sanitized).toContain('[REDACTED_SEED_PHRASE]')
  })
})
```

### Integration Tests

1. **Prompt Execution**: Execute prompt → Verify sanitization → Verify logging
2. **Tool Invocation**: Invoke tool → Verify guardrails → Verify approval flow
3. **External Calls**: Make external call → Validate → Verify rate limiting
4. **Fallback Paths**: Trigger failure → Verify fallback → Verify logging

## Audit and Monitoring

### Metrics to Track

- `assistant_tokens_total` - Total tokens spent
- `assistant_tool_calls_total` - Total tool calls by outcome
- `assistant_tool_call_duration_seconds` - Tool execution duration
- `assistant_fallback_total` - Fallback activations by reason
- `external_call_errors_total` - External call failures by service

### Audit Log Fields

```typescript
interface AgentToolInvocationLog {
  id: string
  toolName: string
  userId: string
  parameters: Record<string, unknown>
  result: unknown
  durationMs: number
  approved: boolean
  timestamp: Date
  ipAddress?: string
  userAgent?: string
}
```

### Alert Rules

| Alert | Condition | Severity |
|-------|-----------|----------|
| High-Risk Tool Without Approval | High-risk tool executed without approval | Critical |
| Prohibited Tool Invocation | Attempt to invoke prohibited tool | Critical |
| External Call Rate Limit Exceeded | Rate limit exceeded for external service | Warning |
| AI Token Budget Exceeded | Token budget exceeded | Warning |
| Fallback Activated | Fallback to rule-based parser | Info |

## Implementation References

- **Assistant Service**: `src/agent/assistant/`
- **Tool Guardrails**: `src/agent/tools/guardrails.ts` (to be created)
- **Metrics**: `src/utils/metrics.ts`
- **Configuration**: `src/config/env.ts`
