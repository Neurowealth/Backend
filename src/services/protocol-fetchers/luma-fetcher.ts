import axios from 'axios';
import { ProtocolRateSource } from './types';

export class LumaFetcher {
  private readonly baseUrl = 'https://api.luma.markets/v1';
  private readonly timeout = 5000;
  private readonly maxRetries = 3;

  async fetchRate(): Promise<ProtocolRateSource> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await axios.get(`${this.baseUrl}/rates`, {
          timeout: this.timeout,
        });

        const apy = this.calculateApy(response.data);
        const tvl = this.calculateTvl(response.data);

        return {
          protocol: 'luma',
          apy,
          tvl,
          timestamp: new Date(),
          rawData: response.data,
          source: 'luma-api',
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`Luma fetch attempt ${attempt + 1} failed:`, lastError.message);

        if (attempt < this.maxRetries - 1) {
          await this.delay(Math.pow(2, attempt) * 1000);
        }
      }
    }

    throw lastError || new Error('Failed to fetch Luma rates after retries');
  }

  private calculateApy(data: Record<string, unknown>): number {
    return (data as any).apy || 0;
  }

  private calculateTvl(data: Record<string, unknown>): number {
    return (data as any).tvl || 0;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
