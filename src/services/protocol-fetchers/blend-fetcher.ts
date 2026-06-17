import axios from 'axios';
import { ProtocolRateSource } from './types';

export class BlendFetcher {
  private readonly baseUrl = 'https://api.blend-labs.com/v1';
  private readonly timeout = 5000;
  private readonly maxRetries = 3;

  async fetchRate(): Promise<ProtocolRateSource> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await axios.get(`${this.baseUrl}/pools`, {
          timeout: this.timeout,
        });

        const apy = this.calculateApy(response.data);
        const tvl = this.calculateTvl(response.data);

        return {
          protocol: 'blend',
          apy,
          tvl,
          timestamp: new Date(),
          rawData: response.data,
          source: 'blend-api',
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`Blend fetch attempt ${attempt + 1} failed:`, lastError.message);

        if (attempt < this.maxRetries - 1) {
          await this.delay(Math.pow(2, attempt) * 1000); // exponential backoff
        }
      }
    }

    throw lastError || new Error('Failed to fetch Blend rates after retries');
  }

  private calculateApy(data: Record<string, unknown>): number {
    // Parse Blend API response and calculate APY
    return (data as any).averageApy || 0;
  }

  private calculateTvl(data: Record<string, unknown>): number {
    // Calculate total value locked
    return (data as any).totalLiquidity || 0;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
