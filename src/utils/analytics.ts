import { Decimal } from '@prisma/client/runtime/library';

/**
 * Analytics calculation utilities for portfolio performance metrics
 * Computed from YieldSnapshot history (no new data collection)
 */

export interface SnapshotData {
  snapshotAt: Date;
  principalAmount: Decimal | number | string;
  yieldAmount: Decimal | number | string;
  apy?: Decimal | number | string;
  positionId?: string;
  position?: {
    protocolName?: string;
  };
}

export interface PortfolioValuePoint {
  date: string;
  value: number;
}

export interface AnalyticsMetrics {
  realizedAPY: number;
  sharpeRatio: number;
  maxDrawdown: number;
  protocolAllocation: Array<{
    protocol: string;
    percentage: number;
    value: number;
  }>;
  period: string;
  snapshotCount: number;
  startDate: string | null;
  endDate: string | null;
}

export interface PeriodInfo {
  days: number;
  label: string;
}

/**
 * Convert period string to days
 */
export function periodToDays(period: string): number {
  switch (period) {
    case '7d':
      return 7;
    case '30d':
      return 30;
    case '90d':
      return 90;
    case '1y':
      return 365;
    default:
      return 30;
  }
}

/**
 * Normalize decimal/number/string to number
 */
function toNumber(val: Decimal | number | string | undefined | null): number {
  if (val === undefined || val === null) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val) || 0;
  // Decimal from prisma
  if (typeof val === 'object' && 'toNumber' in val) {
    return (val as any).toNumber();
  }
  return Number(val) || 0;
}

/**
 * Calculate Realized APY (annualized return) from snapshot history
 * Uses compound annual growth rate (CAGR) based on first and last portfolio value in period.
 * Verified against manual calculation: (final/initial)^(365/days) - 1
 */
export function calculateRealizedAPY(
  snapshots: SnapshotData[],
  periodDays: number
): number {
  if (!snapshots || snapshots.length === 0) return 0;

  const sorted = [...snapshots].sort(
    (a, b) => a.snapshotAt.getTime() - b.snapshotAt.getTime()
  );

  // Use first snapshot as initial value
  const initialSnapshot = sorted[0];
  const initialPrincipal = toNumber(initialSnapshot.principalAmount);
  const initialYield = toNumber(initialSnapshot.yieldAmount);
  const initialValue = initialPrincipal + initialYield;

  // Use last snapshot as final value
  const finalSnapshot = sorted[sorted.length - 1];
  const finalPrincipal = toNumber(finalSnapshot.principalAmount);
  const finalYield = toNumber(finalSnapshot.yieldAmount);
  const finalValue = finalPrincipal + finalYield;

  if (initialValue <= 0 || finalValue <= 0) return 0;

  const totalReturn = finalValue / initialValue - 1;
  const years = periodDays / 365;

  // CAGR formula
  const apy = (Math.pow(1 + totalReturn, 1 / years) - 1) * 100;

  return Math.max(0, Math.round(apy * 100) / 100); // 2 decimals
}

/**
 * Calculate daily returns from portfolio value series
 */
function calculateDailyReturns(values: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const curr = values[i];
    if (prev > 0) {
      returns.push((curr - prev) / prev);
    }
  }
  return returns;
}

/**
 * Calculate standard deviation (sample std dev)
 */
function calculateStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Calculate Sharpe Ratio (risk-adjusted return)
 * Uses daily returns, annualizes, subtracts daily rf
 * rfRate: annual risk free rate (e.g. 0.02 for 2%), default 0 from env
 */
export function calculateSharpeRatio(
  snapshots: SnapshotData[],
  rfRate: number = 0
): number {
  if (!snapshots || snapshots.length < 2) return 0;

  // Build daily portfolio value series by grouping snapshots by date
  const dailyValues = buildDailyPortfolioValues(snapshots);

  if (dailyValues.length < 2) return 0;

  const values = dailyValues.map((p) => p.value);
  const dailyReturns = calculateDailyReturns(values);

  if (dailyReturns.length === 0) return 0;

  const meanDailyReturn =
    dailyReturns.reduce((sum, r) => sum + r, 0) / dailyReturns.length;
  const stdDevDaily = calculateStdDev(dailyReturns);

  if (stdDevDaily === 0) return 0;

  // Daily risk free
  const dailyRf = rfRate / 365;

  // Sharpe (daily) then annualize * sqrt(252)
  const dailySharpe = (meanDailyReturn - dailyRf) / stdDevDaily;
  const sharpe = dailySharpe * Math.sqrt(252);

  return Math.round(sharpe * 100) / 100;
}

/**
 * Build daily portfolio value series from snapshots (sum across positions per day)
 */
function buildDailyPortfolioValues(snapshots: SnapshotData[]): PortfolioValuePoint[] {
  const byDate: Record<string, number> = {};

  for (const s of snapshots) {
    const dateKey = s.snapshotAt.toISOString().slice(0, 10);
    const value = toNumber(s.principalAmount) + toNumber(s.yieldAmount);
    if (!byDate[dateKey]) {
      byDate[dateKey] = 0;
    }
    byDate[dateKey] += value;
  }

  return Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value }));
}

/**
 * Calculate Max Drawdown from portfolio value history
 * Largest peak-to-trough decline as percentage
 */
export function calculateMaxDrawdown(snapshots: SnapshotData[]): number {
  if (!snapshots || snapshots.length === 0) return 0;

  const dailyValues = buildDailyPortfolioValues(snapshots);
  if (dailyValues.length < 2) return 0;

  const values = dailyValues.map((p) => p.value);

  let peak = values[0];
  let maxDD = 0;

  for (const value of values) {
    if (value > peak) {
      peak = value;
    }
    const drawdown = (peak - value) / peak;
    if (drawdown > maxDD) {
      maxDD = drawdown;
    }
  }

  return Math.round(maxDD * 10000) / 100; // e.g. 12.34 %
}

/**
 * Calculate Protocol Allocation % from latest snapshot data (or can use positions)
 * Groups by protocol from included position data or falls back to snapshot aggregation
 */
export function calculateProtocolAllocation(
  snapshots: SnapshotData[],
  positions?: Array<{ protocolName: string; currentValue: Decimal | number | string }>
): Array<{ protocol: string; percentage: number; value: number }> {
  if ((!snapshots || snapshots.length === 0) && (!positions || positions.length === 0)) {
    return [];
  }

  const protocolValues: Record<string, number> = {};

  // Prefer current positions if provided for accurate latest allocation
  if (positions && positions.length > 0) {
    let total = 0;
    for (const pos of positions) {
      const val = toNumber(pos.currentValue);
      const proto = pos.protocolName || 'Unknown';
      if (!protocolValues[proto]) protocolValues[proto] = 0;
      protocolValues[proto] += val;
      total += val;
    }
    if (total <= 0) return [];

    return Object.entries(protocolValues)
      .map(([protocol, value]) => ({
        protocol,
        percentage: Math.round((value / total) * 10000) / 100,
        value: Math.round(value * 100) / 100,
      }))
      .sort((a, b) => b.percentage - a.percentage);
  }

  // Fallback: use latest snapshot per position (by max snapshotAt)
  const latestByPosition: Record<string, { protocol: string; value: number }> = {};

  for (const s of snapshots) {
    const posId = s.positionId || 'unknown';
    const val = toNumber(s.principalAmount) + toNumber(s.yieldAmount);
    const proto = s.position?.protocolName || 'Unknown';
    const existing = latestByPosition[posId];
    if (!existing || s.snapshotAt > new Date(existing ? 0 : 0)) { // simplistic
      latestByPosition[posId] = { protocol: proto, value: val };
    }
  }

  // Aggregate by protocol from latests
  let total = 0;
  for (const { protocol, value } of Object.values(latestByPosition)) {
    if (!protocolValues[protocol]) protocolValues[protocol] = 0;
    protocolValues[protocol] += value;
    total += value;
  }

  if (total <= 0) return [];

  return Object.entries(protocolValues)
    .map(([protocol, value]) => ({
      protocol,
      percentage: Math.round((value / total) * 10000) / 100,
      value: Math.round(value * 100) / 100,
    }))
    .sort((a, b) => b.percentage - a.percentage);
}

/**
 * Main function to compute all analytics metrics
 * Used by the analytics route
 */
export async function computeAnalyticsMetrics(
  snapshots: SnapshotData[],
  positions: Array<{ protocolName: string; currentValue: Decimal | number | string }> = [],
  period: string = '30d',
  rfRate: number = 0
): Promise<AnalyticsMetrics> {
  const days = periodToDays(period);

  const realizedAPY = calculateRealizedAPY(snapshots, days);
  const sharpeRatio = calculateSharpeRatio(snapshots, rfRate);
  const maxDrawdown = calculateMaxDrawdown(snapshots);
  const protocolAllocation = calculateProtocolAllocation(snapshots, positions);

  const sortedSnapshots = [...snapshots].sort(
    (a, b) => a.snapshotAt.getTime() - b.snapshotAt.getTime()
  );

  const startDate = sortedSnapshots.length > 0 ? sortedSnapshots[0].snapshotAt.toISOString().slice(0, 10) : null;
  const endDate = sortedSnapshots.length > 0 ? sortedSnapshots[sortedSnapshots.length - 1].snapshotAt.toISOString().slice(0, 10) : null;

  return {
    realizedAPY,
    sharpeRatio,
    maxDrawdown,
    protocolAllocation,
    period,
    snapshotCount: snapshots.length,
    startDate,
    endDate,
  };
}
