import { BlendFetcher } from './protocol-fetchers/blend-fetcher';
import { StellarFetcher } from './protocol-fetchers/stellar-fetcher';
import { LumaFetcher } from './protocol-fetchers/luma-fetcher';
import { ProtocolRateSource } from './protocol-fetchers/types';

export interface ProtocolRate {
  protocol: string;
  apy: number;
  tvl: number;
  timestamp: Date;
  rawData: Record<string, unknown>;
  source: string;
  fetchDuration: number;
  isStale: boolean;
}

export class ProtocolRateService {
  private blendFetcher = new BlendFetcher();
  private stellarFetcher = new StellarFetcher();
  private lumaFetcher = new LumaFetcher();
  private fetchMetrics = {
    'blend-duration': 0,
    'stellar-duration': 0,
    'luma-duration': 0,
    'blend-failures': 0,
    'stellar-failures': 0,
    'luma-failures': 0,
  };
  private lastFetchTime: Record<string, number> = {};
  private staleThreshold = 5 * 60 * 1000; // 5 minutes

  async fetchAllRates(): Promise<ProtocolRate[]> {
    const results: ProtocolRate[] = [];

    for (const [protocol, fetcher] of [
      ['blend', this.blendFetcher],
      ['stellar', this.stellarFetcher],
      ['luma', this.lumaFetcher],
    ]) {
      try {
        const startTime = Date.now();
        const rate = await (fetcher as any).fetchRate();
        const duration = Date.now() - startTime;

        results.push({
          ...rate,
          fetchDuration: duration,
          isStale: this.isStale(protocol),
        });

        this.lastFetchTime[protocol] = Date.now();
      } catch (error) {
        console.error(`Failed to fetch ${protocol} rate:`, error);
        this.fetchMetrics[`${protocol}-failures`]++;
      }
    }

    return results;
  }

  private isStale(protocol: string): boolean {
    const lastFetch = this.lastFetchTime[protocol];
    if (!lastFetch) return true;
    return Date.now() - lastFetch > this.staleThreshold;
  }

  getMetrics() {
    return this.fetchMetrics;
  }
}
