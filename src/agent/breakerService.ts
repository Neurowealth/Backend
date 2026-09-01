/**
 * src/agent/breakerService.ts
 *
 * Integration layer for the agent circuit breaker (#345). The heavy lifting
 * (trip rules, state machine) lives in pure modules (breakerRules.ts,
 * breakerState.ts); this service:
 *
 *  1. loads the measurements the rules need (position value series, batch flip
 *     counts, APY-table freshness, stablecoin price),
 *  2. evaluates the enabled rules per scope (GLOBAL -> PROTOCOL -> USER),
 *  3. applies the CLOSED/OPEN/HALF_OPEN state machine and persists transitions,
 *  4. emits operator alerts + user events on trip/reset,
 *  5. exposes a blocking context the rebalance loop consumes before batches.
 *
 * Evaluations FAIL CLOSED: if measurement loading or persistence throws, the
 * caller is told to halt all rebalancing for the tick and an operator alert
 * is emitted — the agent never trades blind when the breaker cannot decide.
 *
 * Withdrawals are deliberately untouched here: this module only gates
 * agent-initiated rebalances. The outbox dispatcher's `isUserHalted` gate
 * (#321) is independent and out of scope.
 */

import { config } from '../config/env'
import db from '../db'
import { logger } from '../utils/logger'
import { alertingService } from '../services/alerting'
import { publishUserEvent } from '../events/publisher'
import { EVENT_TYPE_TOPIC } from '../events/types'
import { recordAgentBreakerTrip, setAgentBreakerState } from '../utils/metrics'
import {
  BreakerRuleConfig,
  BreakerEvalInput,
  evaluateBreakerRules,
  RuleResult,
  ValuePoint,
} from './breakerRules'
import {
  applyBreakerEvaluation,
  applyManualReset,
  applyManualTrip,
  BreakerRecord,
  BreakerScope,
  BreakerState,
  BreakerTransitionConfig,
  describeBreaker,
} from './breakerState'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PositionLike {
  id: string
  userId: string
  protocolName: string
}

export interface BatchLike {
  batchKey: string
  protocol: string
}

/** What the rebalance loop needs to decide which batches may run. */
export interface BreakerBlockContext {
  /** True when a GLOBAL breaker is OPEN (halt everything this tick). */
  globalOpen: boolean
  /** Protocols whose breaker is OPEN (halt batches whose FROM is here). */
  openProtocols: Set<string>
  /** Users whose breaker is OPEN (halt batches containing any of these). */
  openUsers: Set<string>
  /** OPEN-protocol names to exclude as rebalance targets (FROM-AND-TO guard). */
  blockedTargetProtocols: string[]
  /** Breakers that newly tripped this tick. */
  trips: TripRecord[]
  /** Breakers that closed this tick (auto-recovered). */
  closes: TripRecord[]
  /** True when evaluation itself failed — everything blocked (fail-closed). */
  evalFailed: boolean
}

export interface TripRecord {
  id: string
  scope: BreakerScope
  scopeKey: string
  rule: string
  state: BreakerState
  autoResetAt: string | null
}

interface BreakerRowLike {
  id: string
  scope: string
  scopeKey: string
  state: string
  trippedRule: string | null
  detail: unknown
  trippedAt: Date | null
  autoResetAt: Date | null
  resetBy: string | null
  resetAt: Date | null
}

// ── Config adapters ────────────────────────────────────────────────────────────

export function breakerRuleConfig(): BreakerRuleConfig {
  const b = config.breaker
  return {
    abnormalLoss: {
      enabled: b.abnormalLoss.enabled,
      lossPct: b.abnormalLoss.lossPct,
      windowHours: b.abnormalLoss.windowHours,
    },
    depeg: {
      enabled: b.depeg.enabled,
      depegBps: b.depeg.depegBps,
    },
    oscillation: {
      enabled: b.oscillation.enabled,
      maxFlips: b.oscillation.maxFlips,
    },
    staleData: {
      enabled: b.staleData.enabled,
      maxStaleMinutes: b.staleData.staleMinutes,
      maxConsecutiveFailures: b.staleData.consecutiveFailures,
    },
  }
}

export function breakerTransitionConfig(): BreakerTransitionConfig {
  return {
    cooldownMs: config.breaker.cooldownMs,
    maxCooldownMs: config.breaker.maxCooldownMs,
    sustainedClearChecks: config.breaker.depeg.sustainedClearChecks,
  }
}

// ── Stablecoin price provider ──────────────────────────────────────────────────

/**
 * Current USD spot price of the stablecoin the platform prices at $1, or null
 * when no feed is available.
 *
 * #345 explicitly names the fee-oracle/routing path as the de-peg price
 * source. As of this change the fee oracle publishes base-fee/congestion data
 * only — it carries no stablecoin price — and the routing module's path
 * finding is a stub, so there is no real spot price to read. The provider
 * therefore returns null (the rule fails safe: null never trips), and the
 * de-peg rule stays OFF by default (BREAKER_DEPEG_ENABLED=false) until an
 * oracle feed exists. This function is the single integration point for that
 * feed.
 */
export function getStablecoinPrice(): number | null {
  return null
}

// ── Row <-> record adapters ────────────────────────────────────────────────────

function normalizeState(s: string): BreakerState {
  if (s === 'OPEN' || s === 'HALF_OPEN' || s === 'CLOSED') return s
  return 'CLOSED'
}

function normalizeScope(s: string): BreakerScope {
  if (s === 'PROTOCOL' || s === 'USER' || s === 'GLOBAL') return s
  return 'GLOBAL'
}

function rowToRecord(row: BreakerRowLike): BreakerRecord {
  return {
    state: normalizeState(row.state),
    trippedRule: (row.trippedRule as BreakerRecord['trippedRule']) ?? null,
    detail: (row.detail as Record<string, any>) ?? null,
    trippedAt: row.trippedAt ?? null,
    autoResetAt: row.autoResetAt ?? null,
  }
}

function keyFor(scope: BreakerScope, scopeKey: string): string {
  return scope === 'GLOBAL' ? 'GLOBAL' : `${scope}:${scopeKey}`
}

function emptyRecord(): BreakerRecord {
  return {
    state: 'CLOSED',
    trippedRule: null,
    detail: null,
    trippedAt: null,
    autoResetAt: null,
  }
}

const SNAPSHOT_ALERT_SEVERITY = 'critical'
const RESET_ALERT_SEVERITY = 'info'

// ── Measurement loads ──────────────────────────────────────────────────────────

function toNumber(v: unknown): number {
  return typeof v === 'number' ? v : parseFloat(String(v ?? '0'))
}

function toSeries(entries: Array<[number, number]>): ValuePoint[] {
  return entries
    .map(([t, value]) => ({ at: new Date(t), value }))
    .sort((a, b) => a.at.getTime() - b.at.getTime())
}

interface ValueSeriesByKey {
  global: ValuePoint[]
  byProtocol: Map<string, ValuePoint[]>
  byUser: Map<string, ValuePoint[]>
}

/**
 * Aggregate mark-to-market value series per scope from YieldSnapshot rows.
 * Each snapshot's value is principal + yield at that time (the same rows the
 * position-history API reads). Series are summed across positions sharing a
 * scope key, oldest-first.
 */
async function loadValueSeries(
  positions: PositionLike[],
  windowHours: number,
  now: Date
): Promise<ValueSeriesByKey> {
  const ids = positions.map((p) => p.id).filter(Boolean)
  const byPosition = new Map(positions.map((p) => [p.id, p]))

  const empty: ValueSeriesByKey = {
    global: [],
    byProtocol: new Map(),
    byUser: new Map(),
  }
  if (ids.length === 0) return empty

  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000)

  const snapshots = await db.yieldSnapshot.findMany({
    where: { positionId: { in: ids }, snapshotAt: { gte: windowStart } },
    select: {
      positionId: true,
      snapshotAt: true,
      principalAmount: true,
      yieldAmount: true,
    },
  })

  const buckets = new Map<string, Map<number, number>>()
  const record = (key: string, t: number, value: number) => {
    let m = buckets.get(key)
    if (!m) {
      m = new Map()
      buckets.set(key, m)
    }
    m.set(t, (m.get(t) ?? 0) + value)
  }

  for (const s of snapshots as Array<{
    positionId: string
    snapshotAt: Date
    principalAmount: unknown
    yieldAmount: unknown
  }>) {
    const pos = byPosition.get(s.positionId)
    if (!pos) continue
    const value = toNumber(s.principalAmount) + toNumber(s.yieldAmount)
    if (!Number.isFinite(value)) continue
    const t = s.snapshotAt.getTime()
    record('global', t, value)
    record(`proto:${pos.protocolName}`, t, value)
    record(`user:${pos.userId}`, t, value)
  }

  const global = toSeries(
    buckets.get('global') ? Array.from(buckets.get('global')!) : []
  )

  const byProtocol = new Map<string, ValuePoint[]>()
  const byUser = new Map<string, ValuePoint[]>()
  for (const [k, m] of buckets) {
    const series = toSeries(Array.from(m.entries()))
    if (k.startsWith('proto:')) byProtocol.set(k.slice('proto:'.length), series)
    else if (k.startsWith('user:')) byUser.set(k.slice('user:'.length), series)
  }

  return { global, byProtocol, byUser }
}

/** REBALANCED decision count per batchKey within the flip window. */
async function loadFlipCounts(
  batchKeys: string[],
  flipWindowHours: number,
  now: Date
): Promise<Map<string, number>> {
  const keys = Array.from(new Set(batchKeys.filter(Boolean)))
  const counts = new Map(keys.map((k) => [k, 0]))
  if (keys.length === 0) return counts

  const windowStart = new Date(now.getTime() - flipWindowHours * 60 * 60 * 1000)
  const rows = await db.rebalanceDecision.groupBy({
    by: ['batchKey'],
    where: {
      batchKey: { in: keys },
      outcome: 'REBALANCED',
      createdAt: { gte: windowStart },
    },
    _count: { _all: true },
  })

  for (const r of rows as Array<{
    batchKey: string
    _count: { _all: number }
  }>) {
    counts.set(r.batchKey, r._count._all)
  }
  return counts
}

async function loadLatestProtocolRate(): Promise<{
  latestFetchedAt: Date | null
  fresh: boolean
}> {
  const row = await db.protocolRate.findFirst({
    orderBy: { fetchedAt: 'desc' },
    select: { fetchedAt: true },
  })
  const latestFetchedAt = row?.fetchedAt ?? null
  const fresh =
    latestFetchedAt !== null &&
    Date.now() - latestFetchedAt.getTime() <
      config.breaker.staleData.staleMinutes * 60 * 1000
  return { latestFetchedAt, fresh }
}

/** Consecutive failed scans — in-memory, like the scanner's own counters. */
let staleDataFailureCount = 0

function trackScanHealth(fresh: boolean): void {
  staleDataFailureCount = fresh ? 0 : staleDataFailureCount + 1
}

// ── Sync status cache (for the sync getAgentStatus surface) ───────────────────

let cachedGlobalSummary: {
  state: string
  trippedRule: string | null
  autoResetAt: string | null
} | null = null

function updateGlobalCache(wk: WorkingBreaker | undefined, now: Date): void {
  void now
  if (!wk) {
    cachedGlobalSummary = null
    return
  }
  cachedGlobalSummary = {
    state: wk.record.state,
    trippedRule: wk.record.trippedRule,
    autoResetAt: wk.record.autoResetAt?.toISOString() ?? null,
  }
}

/** Same shape exposed by listBreakers but DB-free, for the sync status route. */
export function getBreakerStatusSummary(): {
  global: {
    state: string
    trippedRule: string | null
    autoResetAt: string | null
  } | null
} {
  return { global: cachedGlobalSummary }
}

/**
 * User-facing breaker status: what applies to one player. Only plain-language
 * fields — never other users' loss figures or thresholds.
 */
export async function getBreakerStatusForUser(
  userId: string
): Promise<{ global: string | null; affectingYou: string[] }> {
  const rows = await db.agentCircuitBreaker.findMany({
    where: {
      OR: [
        { scope: 'GLOBAL', scopeKey: '' },
        { scope: 'USER', scopeKey: userId },
      ],
    },
  })

  let global: string | null = null
  const affectingYou: string[] = []

  for (const r of rows) {
    // Defense in depth: never infer "applies to me" from the query alone —
    // a USER row only ever describes the calling user.
    if (r.scope === 'USER' && r.scopeKey !== userId) continue
    const state = normalizeState(r.state)
    if (state === 'CLOSED') continue
    if (r.scope === 'GLOBAL') {
      global = r.trippedRule ?? 'open'
    } else if (r.scope === 'USER') {
      affectingYou.push(
        `rebalancing paused for your account: ${r.trippedRule ?? 'manual'}`
      )
    }
  }

  return { global, affectingYou }
}

// ── Alerts + user events ───────────────────────────────────────────────────────

function safeAlert(
  payload: Parameters<typeof alertingService.emit>[0],
  alertKey: string
): void {
  try {
    void alertingService.emit(payload, alertKey).catch(() => {})
  } catch {
    // alerting must never break the money path
  }
}

function plainTripReason(rule: string, scope: BreakerScope): string {
  switch (rule) {
    case 'abnormal_loss':
      return 'Your portfolio has taken an abnormal loss; the agent paused automatic rebalancing to avoid churning fees while positions fall.'
    case 'depeg':
      return 'A stablecoin the platform prices at $1 moved outside its band; the agent paused automatic rebalancing around that asset.'
    case 'oscillation':
      return 'Rebalancing flipped between protocols repeatedly; the agent paused to stop burning fees.'
    case 'stale_data':
      return 'Yield data is stale or unavailable; the agent paused rebalancing rather than trade on outdated rates.'
    case 'manual':
      return scope === 'USER'
        ? 'An operator paused automatic rebalancing for your account.'
        : 'An operator paused automatic rebalancing.'
    default:
      return 'Automatic rebalancing has been paused.'
  }
}

function emitTripEvents(
  scope: BreakerScope,
  scopeKey: string,
  rule: string,
  users: string[]
): void {
  const described = scope === 'GLOBAL' ? 'globally' : `for ${scope} ${scopeKey}`
  safeAlert(
    {
      title: `Agent circuit breaker tripped (${rule})`,
      description: `Rebalancing is paused ${described}. Rule: ${rule}. Auto-recovery: when the cooldown elapses and the condition clears.`,
      severity: SNAPSHOT_ALERT_SEVERITY as 'critical',
      component: 'agent-breaker',
      metadata: { scope, scopeKey, rule },
    },
    `agent-breaker:trip:${scope}:${scopeKey}`
  )

  if (scope === 'GLOBAL' || scope === 'USER') {
    publishUserEvent(
      users,
      EVENT_TYPE_TOPIC['agent.circuit_breaker_tripped'],
      'agent.circuit_breaker_tripped',
      {
        scope,
        scopeKey,
        rule,
        reason: plainTripReason(rule, scope),
      }
    ).catch(() => {})
  }
}

function emitResetEvents(
  scope: BreakerScope,
  scopeKey: string,
  rule: string,
  users: string[]
): void {
  const described = scope === 'GLOBAL' ? 'globally' : `for ${scope} ${scopeKey}`
  safeAlert(
    {
      title: `Agent circuit breaker reset (${rule})`,
      description: `Rebalancing may resume ${described}.`,
      severity: RESET_ALERT_SEVERITY as 'info',
      component: 'agent-breaker',
      metadata: { scope, scopeKey, rule },
    },
    `agent-breaker:reset:${scope}:${scopeKey}`
  )

  if (scope === 'GLOBAL' || scope === 'USER') {
    publishUserEvent(
      users,
      EVENT_TYPE_TOPIC['agent.circuit_breaker_reset'],
      'agent.circuit_breaker_reset',
      {
        scope,
        scopeKey,
        rule,
        reason: 'Rebalancing has resumed.',
      }
    ).catch(() => {})
  }
}

/** Fail-closed alert when the breaker evaluation itself errors. */
export function emitBreakerEvalFailureAlert(error: string): void {
  safeAlert(
    {
      title: 'Agent circuit breaker evaluation failed',
      description: `Breaker evaluation threw (${error}); all rebalancing is halted for the tick (fail-closed).`,
      severity: SNAPSHOT_ALERT_SEVERITY as 'critical',
      component: 'agent-breaker',
      metadata: { error },
    },
    'agent-breaker:eval-failed'
  )
}

// ── Tick evaluation ─────────────────────────────────────────────────────────────

interface WorkingBreaker {
  key: string
  id: string
  scope: BreakerScope
  scopeKey: string
  row: BreakerRowLike
  record: BreakerRecord
  persisted: boolean
}

async function loadWorkingBreakers(
  now: Date
): Promise<Map<string, WorkingBreaker>> {
  const rows = await db.agentCircuitBreaker.findMany()
  const map = new Map<string, WorkingBreaker>()
  for (const r of rows) {
    const scope = normalizeScope(r.scope as string)
    const wk: WorkingBreaker = {
      key: keyFor(scope, r.scopeKey),
      id: r.id,
      scope,
      scopeKey: r.scopeKey,
      row: {
        id: r.id,
        scope: r.scope,
        scopeKey: r.scopeKey,
        state: r.state,
        trippedRule: r.trippedRule,
        detail: r.detail,
        trippedAt: r.trippedAt,
        autoResetAt: r.autoResetAt,
        resetBy: r.resetBy,
        resetAt: r.resetAt,
      },
      record: rowToRecord({ ...r } as unknown as BreakerRowLike),
      persisted: true,
    }
    map.set(wk.key, wk)
  }
  return map
}

function recordsEqual(a: BreakerRecord, b: BreakerRecord): boolean {
  return (
    a.state === b.state &&
    a.trippedRule === b.trippedRule &&
    a.trippedAt?.getTime() === b.trippedAt?.getTime() &&
    a.autoResetAt?.getTime() === b.autoResetAt?.getTime() &&
    JSON.stringify(a.detail ?? null) === JSON.stringify(b.detail ?? null)
  )
}

function getOrCreate(
  map: Map<string, WorkingBreaker>,
  scope: BreakerScope,
  scopeKey: string
): WorkingBreaker {
  const key = keyFor(scope, scopeKey)
  const existing = map.get(key)
  if (existing) return existing
  const created: WorkingBreaker = {
    key,
    id: key + ':unpersisted',
    scope,
    scopeKey,
    row: {
      id: key + ':unpersisted',
      scope,
      scopeKey,
      state: 'CLOSED',
      trippedRule: null,
      detail: null,
      trippedAt: null,
      autoResetAt: null,
      resetBy: null,
      resetAt: null,
    },
    record: emptyRecord(),
    persisted: false,
  }
  map.set(key, created)
  return created
}

async function persistIfChanged(
  wk: WorkingBreaker,
  prev: BreakerRecord,
  next: BreakerRecord
): Promise<void> {
  if (recordsEqual(prev, next)) return
  if (!wk.persisted && next.state === 'CLOSED' && next.trippedRule === null)
    return

  const data = {
    state: next.state,
    trippedRule: next.trippedRule,
    trippedAt: next.trippedAt,
    detail: (next.detail as any) ?? undefined,
    autoResetAt: next.autoResetAt,
  }

  if (wk.persisted) {
    await db.agentCircuitBreaker.update({ where: { id: wk.id }, data })
  } else {
    const created = await db.agentCircuitBreaker.create({
      data: { scope: wk.scope, scopeKey: wk.scopeKey, ...data },
    })
    wk.persisted = true
    wk.id = created.id
  }
}

/**
 * Apply one rule outcome to a working breaker and record trip/close events.
 */
async function applyAndRecord(
  wk: WorkingBreaker,
  outcome: RuleResult,
  now: Date,
  usersAffected: string[]
): Promise<void> {
  const prev = wk.record
  const next = applyBreakerEvaluation(
    prev,
    outcome,
    now,
    breakerTransitionConfig()
  )

  const stateChanged = prev.state !== next.state

  if (!stateChanged) {
    // Still CLOSED or still OPEN. An OPEN breaker accrues lastEvaluation
    // detail — persist that so operators can inspect failed probes.
    if (next.state === 'OPEN' && !recordsEqual(prev, next)) {
      wk.record = next
      await persistIfChanged(wk, prev, next)
    }
    return
  }

  // CLOSED -> OPEN  or  HALF_OPEN -> OPEN: a trip.
  if (next.state === 'OPEN') {
    wk.record = next
    await persistIfChanged(wk, prev, next)
    recordAgentBreakerTrip(wk.scope, next.trippedRule ?? outcome.rule)
    setAgentBreakerState(wk.scope, wk.scopeKey, 'OPEN')
    emitTripEvents(
      wk.scope,
      wk.scopeKey,
      next.trippedRule ?? outcome.rule,
      usersAffected
    )
    return
  }

  // OPEN -> HALF_OPEN: cooldown elapsed + condition cleared; probed.
  if (next.state === 'HALF_OPEN') {
    wk.record = next
    await persistIfChanged(wk, prev, next)
    return
  }

  // HALF_OPEN -> CLOSED: recovered.
  if (next.state === 'CLOSED' && prev.state === 'HALF_OPEN') {
    wk.record = next
    await persistIfChanged(wk, prev, next)
    emitResetEvents(
      wk.scope,
      wk.scopeKey,
      prev.trippedRule ?? 'auto',
      usersAffected
    )
    return
  }

  wk.record = next
  await persistIfChanged(wk, prev, next)
}

/**
 * Evaluate breakers for one agent tick and return the blocking context for the
 * rebalance loop. Throws on DB failure — the loop catches and fails closed.
 */
export async function evaluateBreakerTick(
  positions: PositionLike[],
  batches: BatchLike[],
  now: Date
): Promise<BreakerBlockContext> {
  const ruleCfg = breakerRuleConfig()
  const transCfg = breakerTransitionConfig()

  // Load measurements once per tick.
  const series = await loadValueSeries(
    positions,
    ruleCfg.abnormalLoss.windowHours,
    now
  )
  const flipCounts = await loadFlipCounts(
    batches.map((b) => b.batchKey),
    config.breaker.oscillation.windowHours,
    now
  )
  const { latestFetchedAt, fresh } = await loadLatestProtocolRate()
  trackScanHealth(fresh)

  const depegPrice = config.breaker.depeg.enabled ? getStablecoinPrice() : null

  const byKey = await loadWorkingBreakers(now)
  const trips: TripRecord[] = []
  const closes: TripRecord[] = []
  const usersByProtocol = new Map<string, string[]>()

  const protocols = Array.from(new Set(positions.map((p) => p.protocolName)))
  const userIds = Array.from(new Set(positions.map((p) => p.userId)))
  for (const p of protocols) {
    usersByProtocol.set(
      p,
      positions.filter((x) => x.protocolName === p).map((x) => x.userId)
    )
  }

  const evalStaleness: Pick<
    BreakerEvalInput,
    'latestFetchedAt' | 'consecutiveFailures' | 'now'
  > = {
    latestFetchedAt,
    consecutiveFailures: staleDataFailureCount,
    now,
  }

  // GLOBAL: stale_data + abnormal_loss.
  {
    const wk = getOrCreate(byKey, 'GLOBAL', '')
    const outcome = evaluateBreakerRules(ruleCfg, {
      ...evalStaleness,
      abnormalLossSeries: ruleCfg.abnormalLoss.enabled
        ? series.global
        : undefined,
      depegPrice,
      oscillationFlips: 0,
    })
    const before = wk.record
    await applyAndRecord(wk, outcome, now, userIds)
    if (before.state !== 'OPEN' && wk.record.state === 'OPEN') {
      trips.push(toTripRecord(wk))
    } else if (before.state === 'HALF_OPEN' && wk.record.state === 'CLOSED') {
      closes.push(toTripRecord(wk))
    }
  }

  // PROTOCOL: abnormal_loss (per protocol) + oscillation (batch flips) + depeg.
  for (const protocol of protocols) {
    const wk = getOrCreate(byKey, 'PROTOCOL', protocol)
    const batchKeys = batches
      .filter((b) => b.protocol === protocol)
      .map((b) => b.batchKey)
    const maxFlips = Math.max(
      0,
      ...batchKeys.map((k) => flipCounts.get(k) ?? 0)
    )
    const outcome = evaluateBreakerRules(ruleCfg, {
      ...evalStaleness,
      abnormalLossSeries: ruleCfg.abnormalLoss.enabled
        ? (series.byProtocol.get(protocol) ?? [])
        : undefined,
      depegPrice,
      oscillationFlips: maxFlips,
    })
    const before = wk.record
    await applyAndRecord(wk, outcome, now, usersByProtocol.get(protocol) ?? [])
    if (before.state !== 'OPEN' && wk.record.state === 'OPEN') {
      trips.push(toTripRecord(wk))
    } else if (before.state === 'HALF_OPEN' && wk.record.state === 'CLOSED') {
      closes.push(toTripRecord(wk))
    }
  }

  // USER: abnormal_loss per user.
  for (const userId of userIds) {
    const wk = getOrCreate(byKey, 'USER', userId)
    const outcome = evaluateBreakerRules(ruleCfg, {
      ...evalStaleness,
      abnormalLossSeries: ruleCfg.abnormalLoss.enabled
        ? (series.byUser.get(userId) ?? [])
        : undefined,
      depegPrice,
      oscillationFlips: 0,
    })
    const before = wk.record
    await applyAndRecord(wk, outcome, now, [userId])
    if (before.state !== 'OPEN' && wk.record.state === 'OPEN') {
      trips.push(toTripRecord(wk))
    } else if (before.state === 'HALF_OPEN' && wk.record.state === 'CLOSED') {
      closes.push(toTripRecord(wk))
    }
  }

  // Build the blocking context from the (now final) states.
  const openProtocols = new Set<string>()
  const openUsers = new Set<string>()
  const blockedTargetProtocols = new Set<string>()

  let globalOpen = false
  let globalWk: WorkingBreaker | undefined
  for (const wk of byKey.values()) {
    if (wk.scope === 'GLOBAL') globalWk = wk
    const open = wk.record.state === 'OPEN' || wk.record.state === 'HALF_OPEN'
    if (!open) continue
    if (wk.scope === 'GLOBAL') globalOpen = true
    if (wk.scope === 'PROTOCOL') {
      openProtocols.add(wk.scopeKey)
      blockedTargetProtocols.add(wk.scopeKey)
    }
    if (wk.scope === 'USER') openUsers.add(wk.scopeKey)
  }

  updateGlobalCache(globalWk, now)

  logger.info('[Breaker] tick complete', {
    globalOpen,
    openProtocols: Array.from(openProtocols),
    openUsers: Array.from(openUsers).length,
    trips: trips.map((t) => t.rule),
    closes: closes.map((c) => c.rule),
  })

  for (const wk of byKey.values()) {
    setAgentBreakerState(wk.scope, wk.scopeKey, wk.record.state)
  }

  return {
    globalOpen,
    openProtocols,
    openUsers,
    blockedTargetProtocols: Array.from(blockedTargetProtocols),
    trips,
    closes,
    evalFailed: false,
  }
}

function toTripRecord(wk: WorkingBreaker): TripRecord {
  return {
    id: wk.id,
    scope: wk.scope,
    scopeKey: wk.scopeKey,
    rule: wk.record.trippedRule ?? 'auto',
    state: wk.record.state,
    autoResetAt: wk.record.autoResetAt?.toISOString() ?? null,
  }
}

// ── Manual admin operations (used by admin routes) ────────────────────────────

export async function listBreakers(): Promise<Array<Record<string, unknown>>> {
  const rows = await db.agentCircuitBreaker.findMany({
    orderBy: { updatedAt: 'desc' },
  })
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    scopeKey: r.scopeKey,
    state: r.state,
    trippedRule: r.trippedRule,
    trippedAt: r.trippedAt?.toISOString() ?? null,
    autoResetAt: r.autoResetAt?.toISOString() ?? null,
    resetBy: r.resetBy,
    resetAt: r.resetAt?.toISOString() ?? null,
    detail: r.detail,
    updatedAt: r.updatedAt.toISOString(),
  }))
}

async function activeUserIds(): Promise<string[]> {
  const rows = await db.user.findMany({
    where: { isActive: true },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

export async function manualTripBreaker(
  scope: BreakerScope,
  scopeKey: string,
  reason: string,
  adminIdentity: string
): Promise<Record<string, unknown>> {
  const now = new Date()
  const existing = await db.agentCircuitBreaker.findUnique({
    where: { scope_scopeKey: { scope, scopeKey } },
  })

  const record = existing
    ? rowToRecord(existing as unknown as BreakerRowLike)
    : emptyRecord()

  if (record.state === 'OPEN' && record.trippedRule === 'manual' && existing) {
    // Already manually open — no-op, return current state.
    return {
      id: existing.id,
      scope,
      scopeKey,
      state: record.state,
      trippedRule: record.trippedRule,
      trippedAt: record.trippedAt?.toISOString() ?? null,
      autoResetAt: record.autoResetAt?.toISOString() ?? null,
    }
  }

  const next = applyManualTrip(record, now, breakerTransitionConfig())

  let id: string
  if (existing) {
    id = existing.id
    await db.agentCircuitBreaker.update({
      where: { id },
      data: {
        state: next.state,
        trippedRule: next.trippedRule,
        trippedAt: next.trippedAt,
        detail: (next.detail as any) ?? undefined,
        autoResetAt: next.autoResetAt,
        resetBy: null,
        resetAt: null,
      },
    })
  } else {
    const created = await db.agentCircuitBreaker.create({
      data: {
        scope,
        scopeKey,
        state: next.state,
        trippedRule: next.trippedRule,
        trippedAt: next.trippedAt,
        detail: (next.detail as any) ?? undefined,
        autoResetAt: next.autoResetAt,
      },
    })
    id = created.id
  }

  const users =
    scope === 'GLOBAL'
      ? await activeUserIds()
      : scope === 'USER'
        ? [scopeKey]
        : []
  emitTripEvents(scope, scopeKey, 'manual', users)

  const persisted = await db.agentCircuitBreaker.findUniqueOrThrow({
    where: { id },
  })
  return {
    id,
    scope,
    scopeKey,
    reason,
    resetBy: adminIdentity,
    ...describeBreaker(rowToRecord(persisted as unknown as BreakerRowLike)),
  }
}

export async function manualResetBreaker(
  id: string,
  reason: string,
  adminIdentity: string
): Promise<Record<string, unknown> | null> {
  const existing = await db.agentCircuitBreaker.findUnique({ where: { id } })
  if (!existing) return null
  const now = new Date()
  const next = applyManualReset(
    rowToRecord(existing as unknown as BreakerRowLike),
    now,
    adminIdentity,
    reason
  )

  await db.agentCircuitBreaker.update({
    where: { id: existing.id },
    data: {
      state: next.state,
      trippedRule: next.trippedRule,
      trippedAt: next.trippedAt,
      detail: (next.detail as any) ?? undefined,
      autoResetAt: next.autoResetAt,
      resetBy: adminIdentity,
      resetAt: now,
    },
  })

  const scope = normalizeScope(existing.scope)
  const users =
    scope === 'GLOBAL'
      ? await activeUserIds()
      : scope === 'USER'
        ? [existing.scopeKey]
        : []
  emitResetEvents(scope, existing.scopeKey, 'manual', users)

  return {
    id,
    scope: scope,
    scopeKey: existing.scopeKey,
    resetBy: adminIdentity,
    reason,
    state: next.state,
  }
}
