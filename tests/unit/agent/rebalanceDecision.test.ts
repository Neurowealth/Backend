import {
  heldDecisionIdentity,
  mergeAffectedUserIds,
  decisionAuditPayload,
} from '../../../src/agent/rebalanceDecision'
import { rankCandidates } from '../../../src/agent/strategies'
import type { YieldProtocol } from '../../../src/agent/types'

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

function makeProtocol(overrides: Partial<YieldProtocol> = {}): YieldProtocol {
  return {
    name: 'Blend',
    apy: 5,
    assetSymbol: 'USDC',
    lastUpdated: new Date(),
    isAvailable: true,
    ...overrides,
  }
}

describe('rebalanceDecision helpers', () => {
  describe('heldDecisionIdentity', () => {
    it('is stable for identical inputs', () => {
      const thresholds = { minimumImprovement: 0.5, maxGasPercent: 0.1 }
      const candidates = [
        {
          protocol: 'Luma',
          apy: 8,
          riskScore: 70,
          eligible: true,
          rejectionReason: null,
        },
        {
          protocol: 'Blend',
          apy: 5,
          riskScore: 80,
          eligible: true,
          rejectionReason: 'lower_apy',
        },
      ] as any
      const a = heldDecisionIdentity(thresholds, candidates)
      const b = heldDecisionIdentity(thresholds, candidates)
      expect(a).toBe(b)
    })

    it('changes when thresholds change', () => {
      const candidates = [
        {
          protocol: 'Luma',
          apy: 8,
          riskScore: null,
          eligible: true,
          rejectionReason: null,
        },
      ] as any
      const a = heldDecisionIdentity(
        { minimumImprovement: 0.5, maxGasPercent: 0.1 },
        candidates
      )
      const b = heldDecisionIdentity(
        { minimumImprovement: 1.0, maxGasPercent: 0.1 },
        candidates
      )
      expect(a).not.toBe(b)
    })

    it('changes when candidates ranking changes', () => {
      const thresholds = { minimumImprovement: 0.5, maxGasPercent: 0.1 }
      const a = heldDecisionIdentity(thresholds, [
        {
          protocol: 'Luma',
          apy: 8,
          riskScore: null,
          eligible: true,
          rejectionReason: null,
        },
      ] as any)
      const b = heldDecisionIdentity(thresholds, [
        {
          protocol: 'Blend',
          apy: 5,
          riskScore: null,
          eligible: true,
          rejectionReason: null,
        },
      ] as any)
      expect(a).not.toBe(b)
    })
  })

  describe('mergeAffectedUserIds', () => {
    it('deduplicates and filters falsy', () => {
      expect(mergeAffectedUserIds(['a', 'b'], ['b', 'c'])).toEqual([
        'a',
        'b',
        'c',
      ])
      expect(mergeAffectedUserIds([], ['x'])).toEqual(['x'])
      expect(mergeAffectedUserIds(['a'], [])).toEqual(['a'])
    })
  })

  describe('decisionAuditPayload', () => {
    it('produces stable hash input with 6dp decimals', () => {
      const input: any = {
        batchKey: 'Blend:MAX_YIELD:none',
        fromProtocol: 'Blend',
        toProtocol: null,
        outcome: 'HELD',
        blockedReason: null,
        strategyName: 'MAX_YIELD',
        strategyIsFollowed: false,
        followedStrategyId: null,
        thresholds: { minimumImprovement: 0.5, maxGasPercent: 0.1 },
        trace: {
          currentApy: 3.5,
          chosenApy: null,
          rawImprovement: 0.123456789,
          netImprovement: 0.1,
          estCostPercent: 0.5,
          candidates: [],
        },
        rationale: 'Already best',
        affectedUserIds: ['b', 'a'],
        affectedPositions: 2,
        outboxOpId: null,
      }
      const payload = decisionAuditPayload(input)
      // affectedUserIds sorted
      expect(payload.affectedUserIds).toEqual(['a', 'b'])
      // 6dp formatting
      expect(payload.currentApy).toBe('3.500000')
      expect(payload.rawImprovement).toBe('0.123457') // rounded
    })
  })

  describe('rankCandidates', () => {
    it('marks winner with null rejectionReason and others lower_apy', () => {
      const protocols = [
        makeProtocol({ name: 'Luma', apy: 8 }),
        makeProtocol({ name: 'Blend', apy: 5 }),
      ]
      const ranked = rankCandidates(protocols, {
        chosenProtocol: 'Luma',
        lowerReason: 'lower_apy',
      })
      expect(ranked[0]).toMatchObject({
        protocol: 'Luma',
        rejectionReason: null,
        eligible: true,
      })
      expect(ranked[1]).toMatchObject({
        protocol: 'Blend',
        rejectionReason: 'lower_apy',
      })
    })

    it('ignores scores when ceiling undefined (backwards compat)', () => {
      const protocols = [
        makeProtocol({ name: 'Luma', apy: 8 }),
        makeProtocol({ name: 'Blend', apy: 5 }),
      ]
      const ranked = rankCandidates(protocols, {
        chosenProtocol: 'Luma',
        lowerReason: 'lower_apy',
        protocolRiskScores: { Luma: 10, Blend: 10 },
        // no ceiling
      })
      expect(ranked[0].riskScore).toBeNull()
      expect(ranked[1].riskScore).toBeNull()
      expect(ranked.every((c) => c.eligible)).toBe(true)
    })

    it('fail-closed when ceiling set and score absent', () => {
      const protocols = [
        makeProtocol({ name: 'Luma', apy: 8 }),
        makeProtocol({ name: 'Blend', apy: 5 }),
      ]
      const ranked = rankCandidates(protocols, {
        chosenProtocol: null,
        lowerReason: 'lower_apy',
        riskCeiling: 50,
        protocolRiskScores: { Luma: 80 },
      })
      const luma = ranked.find((c) => c.protocol === 'Luma')!
      const blend = ranked.find((c) => c.protocol === 'Blend')!
      expect(luma.eligible).toBe(true)
      expect(blend.eligible).toBe(false)
      expect(blend.rejectionReason).toBe('risk_score_unknown')
      expect(blend.riskScore).toBeNull()
    })
  })
})
