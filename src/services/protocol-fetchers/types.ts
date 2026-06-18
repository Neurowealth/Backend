export interface ProtocolRateSource {
  protocol: string;
  apy: number;
  tvl: number;
  timestamp: Date;
  rawData: Record<string, unknown>;
  source: string;
}

export interface FetcherConfig {
  timeout: number;
  maxRetries: number;
  circuitBreakerThreshold: number;
}
