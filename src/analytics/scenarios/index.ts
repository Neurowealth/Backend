/**
 * Scenario definitions — pure, declarative transforms on portfolio (#351).
 * Deterministic, zero I/O; shipped as ~6 built-ins with cited provenance,
 * plus bounded custom path. O(positions).
 */

export interface StressScenario {
  id: string
  label: string
  description: string
  shocks: {
    assetPriceShockPct?: Record<string, number>
    apyShockPct?: number | Record<string, number>
    incentiveApyToZero?: boolean
    protocolLossPct?: Record<string, number>
    recoveryDays?: number
  }
  provenance: string
}

export const STRESS_CAVEAT =
  'Scenarios apply a fixed, historically-calibrated shock to your current holdings. They are not predictions and do not model correlations between shocks or your own or others\' reactions.'

const BUILT_INS: StressScenario[] = [
  {
    id: 'stablecoin_depeg_2022',
    label: '2022 Stablecoin De-peg',
    description: 'Stablecoins dislocate from $1.00 (Terra UST/Luna collapse May 2022 + USDC de-peg Mar 2023).',
    shocks: {
      assetPriceShockPct: { USD_STABLECOIN: -8 },
      recoveryDays: 45,
    },
    provenance: 'Terra UST de-peg May 2022 (Luna Foundation Guard) + USDC de-peg Mar 2023 (Circle, Fed filings); ~8% peak dislocation',
  },
  {
    id: 'yield_collapse',
    label: 'DeFi Yield Collapse',
    description: 'DeFi incentive emissions cut and base yields compress as TVL flees.',
    shocks: {
      apyShockPct: -60,
      incentiveApyToZero: true,
      recoveryDays: 90,
    },
    provenance: 'DeFi Summer 2021 → Bear 2022: Compound/Aave supply APYs fell ~60% (DeFi Llama historical)',
  },
  {
    id: 'protocol_exploit',
    label: 'Protocol Exploit Haircut',
    description: 'A named protocol suffers an exploit and principal is haircut.',
    shocks: {
      protocolLossPct: { Blend: 30, Luma: 30, 'Stellar DEX': 30 },
      recoveryDays: 30,
    },
    provenance: 'Wormhole Feb 2022 ($325m, 30% avg pool haircut) + Nomad Aug 2022 — average 30% principal loss across affected pools',
  },
  {
    id: 'liquidity_crunch',
    label: 'Liquidity Crunch (2023)',
    description: 'Credit tightening drains stable liquidity and compresses yields.',
    shocks: {
      assetPriceShockPct: { USD_STABLECOIN: -2 },
      apyShockPct: -40,
      recoveryDays: 60,
    },
    provenance: '2023 US banking stress (SVB) — stablecoin 2% dislocation, DeFi yields -40% (Federal Reserve, DeFi Llama)',
  },
  {
    id: 'rate_spike',
    label: 'Rate Spike Opportunity',
    description: 'Risk-free rates jump 50% (actually an opportunity — negative impact).',
    shocks: {
      apyShockPct: 50,
      recoveryDays: 30,
    },
    provenance: 'Fed Funds 2022-2023 0.25% → 5.25% (+50% quoted DeFi rate spread, Fed H.15)',
  },
  {
    id: 'bear_market_2022',
    label: 'Broad Bear Market',
    description: 'Correlated drawdown: prices and yields fall together.',
    shocks: {
      assetPriceShockPct: { USD_STABLECOIN: -5, XLM: -15 },
      apyShockPct: -30,
      protocolLossPct: { Blend: 5, Luma: 5 },
      recoveryDays: 180,
    },
    provenance: 'Crypto bear 2022: BTC -65%, DeFi TVL -75% (CoinGecko, DeFi Llama) — blended 15% stable drawdown proxy',
  },
]

export function getBuiltInScenarios(): StressScenario[] {
  return [...BUILT_INS]
}

export function getScenarioById(id: string): StressScenario | undefined {
  return BUILT_INS.find((s) => s.id === id)
}

export function validateCustomScenario(shocks: StressScenario['shocks']): { valid: true } | { valid: false; reason: string } {
  if (!shocks || typeof shocks !== 'object') return { valid: false, reason: 'shocks must be an object' }

  const checkPct = (v: number, field: string) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return `${field} must be a finite number`
    if (Math.abs(v) > 90 && field.includes('assetPrice')) return `${field} |price| > 90% clamped`
    if (field.includes('apyShock')) {
      if (v < -100) return `${field} < -100% clamped`
      if (v > 200) return `${field} > 200% clamped`
    }
    if (field.includes('protocolLoss')) {
      if (v < 0 || v > 90) return `${field} must be 0..90`
    }
    return null
  }

  if (shocks.assetPriceShockPct) {
    if (typeof shocks.assetPriceShockPct !== 'object') return { valid: false, reason: 'assetPriceShockPct must be a record' }
    for (const [k, v] of Object.entries(shocks.assetPriceShockPct)) {
      if (typeof k !== 'string' || !k.trim()) return { valid: false, reason: 'assetPriceShockPct key must be non-empty' }
      const err = checkPct(v, `assetPriceShockPct[${k}]`)
      if (err) return { valid: false, reason: err }
    }
  }
  if (shocks.apyShockPct !== undefined) {
    if (typeof shocks.apyShockPct === 'number') {
      const err = checkPct(shocks.apyShockPct, 'apyShockPct')
      if (err) return { valid: false, reason: err }
    } else if (typeof shocks.apyShockPct === 'object') {
      for (const [k, v] of Object.entries(shocks.apyShockPct)) {
        const err = checkPct(v, `apyShockPct[${k}]`)
        if (err) return { valid: false, reason: err }
      }
    } else {
      return { valid: false, reason: 'apyShockPct must be number or record' }
    }
  }
  if (shocks.protocolLossPct) {
    if (typeof shocks.protocolLossPct !== 'object') return { valid: false, reason: 'protocolLossPct must be a record' }
    for (const [k, v] of Object.entries(shocks.protocolLossPct)) {
      const err = checkPct(v, `protocolLossPct[${k}]`)
      if (err) return { valid: false, reason: err }
    }
  }
  if (shocks.incentiveApyToZero !== undefined && typeof shocks.incentiveApyToZero !== 'boolean') {
    return { valid: false, reason: 'incentiveApyToZero must be boolean' }
  }
  if (shocks.recoveryDays !== undefined) {
    if (!Number.isInteger(shocks.recoveryDays) || shocks.recoveryDays < 1 || shocks.recoveryDays > 365) {
      return { valid: false, reason: 'recoveryDays must be integer 1..365' }
    }
  }
  return { valid: true }
}
