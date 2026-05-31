/**
 * Tests for the event metadata extraction helpers (#65).
 *
 * Exercises asset symbol + protocol name parsing across multiple
 * non-USDC assets and protocols, plus the failure paths that #65 added
 * so that malformed events flow to the DLQ instead of being silently
 * persisted under the legacy `USDC`/`vault` defaults.
 */

import type { ContractEvent } from '../types';
import { Network } from '@prisma/client';

// Mock scValToNative so we can dictate what each topic decodes to
// without having to construct real xdr.ScVal values per test.
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    scValToNative: jest.fn((sv: unknown) => (sv as { __native?: unknown })?.__native),
  };
});

// Keep enum values from @prisma/client; no PrismaClient instantiation needed.
jest.mock('@prisma/client', () => jest.requireActual('@prisma/client'));

// Prevent the db singleton from opening a real connection.
jest.mock('../../db', () => ({ default: {} }));

// Avoid the dlq module pulling in a Prisma connection too.
jest.mock('../dlq', () => ({
  DeadLetterQueue: { add: jest.fn(), retryAll: jest.fn() },
}));

import {
  extractAssetSymbol,
  extractProtocolName,
} from '../events';

/** Build a topic placeholder that the mocked `scValToNative` will decode into the given value. */
const topic = (decoded: unknown): any => ({ __native: decoded });

const baseEvent = (topics: any[]): ContractEvent => ({
  type: 'deposit',
  ledger: 12345,
  txHash: 'tx-abc',
  contractId: 'CTEST',
  topics: topics as any,
  value: topic({}) as any,
});

describe('extractAssetSymbol (#65)', () => {
  it.each([
    ['USDC'],
    ['XLM'],
    ['EURC'],
    ['yXLM'],
    ['BTCLN'],
  ])('returns the dynamic asset symbol "%s" from topic[1]', symbol => {
    const event = baseEvent([
      topic('deposit'),
      topic(symbol),
      topic('aave'),
    ]);
    expect(extractAssetSymbol(event)).toBe(symbol);
  });

  it('throws when topic[1] is missing entirely (no silent USDC fallback)', () => {
    const event = baseEvent([topic('deposit')]);
    expect(() => extractAssetSymbol(event)).toThrow(/Missing asset symbol topic/);
  });

  it('throws when topic[1] is not a string (e.g. numeric encoding)', () => {
    const event = baseEvent([topic('deposit'), topic(42), topic('aave')]);
    expect(() => extractAssetSymbol(event)).toThrow(
      /asset symbol topic at index 1 is not a non-empty string/
    );
  });

  it('throws when topic[1] decodes to an empty string', () => {
    const event = baseEvent([topic('deposit'), topic(''), topic('aave')]);
    expect(() => extractAssetSymbol(event)).toThrow(
      /asset symbol topic at index 1 is not a non-empty string/
    );
  });

  it('wraps the underlying decode error with event context', () => {
    const { scValToNative } = require('@stellar/stellar-sdk');
    (scValToNative as jest.Mock).mockImplementationOnce(() => {
      throw new Error('xdr decode boom');
    });
    const event = baseEvent([topic('deposit'), topic('XLM'), topic('aave')]);
    expect(() => extractAssetSymbol(event)).toThrow(/Failed to decode asset symbol/);
  });
});

describe('extractProtocolName (#65)', () => {
  it.each([
    ['vault'],
    ['aave'],
    ['blend'],
    ['compound'],
    ['stellar-dex'],
  ])('returns the dynamic protocol name "%s" from topic[2]', protocol => {
    const event = baseEvent([
      topic('deposit'),
      topic('XLM'),
      topic(protocol),
    ]);
    expect(extractProtocolName(event)).toBe(protocol);
  });

  it('throws when topic[2] is missing (no silent vault fallback)', () => {
    const event = baseEvent([topic('deposit'), topic('XLM')]);
    expect(() => extractProtocolName(event)).toThrow(
      /Missing protocol name topic/
    );
  });

  it('throws when topic[2] is not a string', () => {
    const event = baseEvent([
      topic('deposit'),
      topic('XLM'),
      topic({ wrong: 'shape' }),
    ]);
    expect(() => extractProtocolName(event)).toThrow(
      /protocol name topic at index 2 is not a non-empty string/
    );
  });

  it('throws when topic[2] decodes to an empty string', () => {
    const event = baseEvent([topic('deposit'), topic('XLM'), topic('')]);
    expect(() => extractProtocolName(event)).toThrow(
      /protocol name topic at index 2 is not a non-empty string/
    );
  });
});

describe('Event parsing carries dynamic asset + protocol through to parsed events (#65)', () => {
  // We re-import the module-scoped parsers via the public surface; the
  // exported handleEvent uses the same parsers and is exercised end-to-end
  // in stellar.test.ts. Here we just verify the parsed object shape using
  // the helpers + a hand-built event payload.
  it('non-USDC + non-vault metadata flows through to the parsed event shape', () => {
    const event = baseEvent([
      topic('deposit'),
      topic('EURC'),
      topic('blend'),
    ]);
    const assetSymbol = extractAssetSymbol(event);
    const protocolName = extractProtocolName(event);
    const network = Network.TESTNET;
    expect({ assetSymbol, protocolName, network }).toEqual({
      assetSymbol: 'EURC',
      protocolName: 'blend',
      network: 'TESTNET',
    });
  });
});
