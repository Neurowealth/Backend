import nock from 'nock';
import { BlendFetcher } from '../src/services/protocol-fetchers/blend-fetcher';
import { StellarFetcher } from '../src/services/protocol-fetchers/stellar-fetcher';
import { LumaFetcher } from '../src/services/protocol-fetchers/luma-fetcher';

describe('Protocol Fetchers', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  describe('BlendFetcher', () => {
    it('should fetch real Blend rates', async () => {
      const mockData = {
        averageApy: 12.5,
        totalLiquidity: 1000000,
      };

      nock('https://api.blend-labs.com')
        .get('/v1/pools')
        .reply(200, mockData);

      const fetcher = new BlendFetcher();
      const result = await fetcher.fetchRate();

      expect(result.protocol).toBe('blend');
      expect(result.apy).toBe(12.5);
      expect(result.tvl).toBe(1000000);
      expect(result.source).toBe('blend-api');
    });

    it('should retry on failure', async () => {
      const mockData = { averageApy: 12.5, totalLiquidity: 1000000 };

      nock('https://api.blend-labs.com')
        .get('/v1/pools')
        .reply(500)
        .get('/v1/pools')
        .reply(200, mockData);

      const fetcher = new BlendFetcher();
      const result = await fetcher.fetchRate();

      expect(result.apy).toBe(12.5);
    });
  });

  describe('StellarFetcher', () => {
    it('should fetch real Stellar rates', async () => {
      const mockData = {
        averageApy: 8.3,
        totalLiquidity: 5000000,
      };

      nock('https://api.stellar.expert')
        .get('/v2/dex/pools')
        .reply(200, mockData);

      const fetcher = new StellarFetcher();
      const result = await fetcher.fetchRate();

      expect(result.protocol).toBe('stellar');
      expect(result.apy).toBe(8.3);
    });
  });

  describe('LumaFetcher', () => {
    it('should fetch real Luma rates', async () => {
      const mockData = {
        apy: 15.2,
        tvl: 2500000,
      };

      nock('https://api.luma.markets')
        .get('/v1/rates')
        .reply(200, mockData);

      const fetcher = new LumaFetcher();
      const result = await fetcher.fetchRate();

      expect(result.protocol).toBe('luma');
      expect(result.apy).toBe(15.2);
    });
  });
});
