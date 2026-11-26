/**
 * Unit tests for parseNumericEnv (#789).
 *
 * The helper is the single validation point for numeric env vars, so these
 * tests pin its contract: fallback-on-empty, strict finite parsing, and the
 * optional integer/min/max guards.
 */
import { parseNumericEnv } from '../../../src/config/numeric-env'

const KEY = 'TEST_PARSE_NUMERIC_ENV'

afterEach(() => {
  delete process.env[KEY]
})

describe('parseNumericEnv', () => {
  it('returns the fallback when the variable is unset', () => {
    expect(parseNumericEnv(KEY, '42')).toBe(42)
    expect(parseNumericEnv(KEY, 42)).toBe(42)
  })

  it('returns the fallback when the variable is empty or whitespace', () => {
    process.env[KEY] = ''
    expect(parseNumericEnv(KEY, '7')).toBe(7)
    process.env[KEY] = '   '
    expect(parseNumericEnv(KEY, '7')).toBe(7)
  })

  it('parses integers, floats, and negatives', () => {
    process.env[KEY] = '3001'
    expect(parseNumericEnv(KEY, '1')).toBe(3001)
    process.env[KEY] = '0.25'
    expect(parseNumericEnv(KEY, '1')).toBe(0.25)
    process.env[KEY] = '-5'
    expect(parseNumericEnv(KEY, '1')).toBe(-5)
  })

  it('rejects non-numeric values with an error naming the variable', () => {
    process.env[KEY] = 'abc'
    expect(() => parseNumericEnv(KEY, '1')).toThrow(/TEST_PARSE_NUMERIC_ENV/)
    process.env[KEY] = '$5'
    expect(() => parseNumericEnv(KEY, '1')).toThrow(/expected a finite number/)
    process.env[KEY] = 'ten'
    expect(() => parseNumericEnv(KEY, '1')).toThrow(/expected a finite number/)
  })

  it('rejects values that strict Number() would truncate', () => {
    process.env[KEY] = '10abc'
    expect(() => parseNumericEnv(KEY, '1')).toThrow(/expected a finite number/)
  })

  it('rejects Infinity', () => {
    process.env[KEY] = 'Infinity'
    expect(() => parseNumericEnv(KEY, '1')).toThrow(/expected a finite number/)
  })

  it('rejects non-integers when integer: true', () => {
    process.env[KEY] = '1.5'
    expect(() => parseNumericEnv(KEY, '1', { integer: true })).toThrow(
      /expected an integer/
    )
    process.env[KEY] = '3'
    expect(parseNumericEnv(KEY, '1', { integer: true })).toBe(3)
  })

  it('enforces an inclusive minimum', () => {
    process.env[KEY] = '-1'
    expect(() => parseNumericEnv(KEY, '1', { min: 1 })).toThrow(
      /greater than or equal to 1/
    )
    process.env[KEY] = '1'
    expect(parseNumericEnv(KEY, '1', { min: 1 })).toBe(1)
  })

  it('enforces an inclusive maximum', () => {
    process.env[KEY] = '2'
    expect(() => parseNumericEnv(KEY, '0.5', { max: 1 })).toThrow(
      /less than or equal to 1/
    )
    process.env[KEY] = '1'
    expect(parseNumericEnv(KEY, '0.5', { max: 1 })).toBe(1)
  })

  it('accepts zero when the minimum allows it', () => {
    process.env[KEY] = '0'
    expect(parseNumericEnv(KEY, '5', { min: 0 })).toBe(0)
  })

  it('throws if the fallback literal itself is not a number', () => {
    expect(() => parseNumericEnv(KEY, 'not-a-number')).toThrow(
      /Invalid default for numeric environment variable/
    )
  })
})
