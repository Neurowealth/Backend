// CSV utility tests (#284): RFC 4180 quoting + spreadsheet formula-injection
// guarding. The injection guard is security-relevant — exported reports are
// opened in Excel/Sheets, so cells must never execute as formulas.
import { escapeCsvField, toCsv } from '../../../src/utils/csv'

describe('escapeCsvField', () => {
  it('returns empty string for null and undefined', () => {
    expect(escapeCsvField(null)).toBe('')
    expect(escapeCsvField(undefined)).toBe('')
  })

  it('passes plain strings through unchanged', () => {
    expect(escapeCsvField('hello')).toBe('hello')
  })

  it('stringifies numbers and booleans', () => {
    expect(escapeCsvField(42)).toBe('42')
    expect(escapeCsvField(true)).toBe('true')
  })

  it('quotes fields containing commas', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"')
  })

  it('doubles internal quotes and wraps', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""')
  })

  it('quotes fields containing newlines and carriage returns', () => {
    expect(escapeCsvField('a\nb')).toBe('"a\nb"')
    expect(escapeCsvField('a\rb')).toBe('"a\rb"')
  })

  it.each([
    ['=cmd()', "'=cmd()"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@x', "'@x"],
  ])('prefixes injection vector %s with a quote', (input, expected) => {
    expect(escapeCsvField(input)).toBe(expected)
  })

  it('guards a leading tab', () => {
    expect(escapeCsvField('\tx')).toBe("'\tx")
  })

  it('guards a leading CR and then quotes (CR also triggers quoting)', () => {
    expect(escapeCsvField('\rx')).toBe('"\'\rx"')
  })

  it('quotes an injection vector that also contains a comma', () => {
    expect(escapeCsvField('=1,2')).toBe('"\'=1,2"')
  })
})

describe('toCsv', () => {
  it('joins header and rows with CRLF', () => {
    const csv = toCsv(
      ['a', 'b'],
      [
        ['1', '2'],
        ['3', '4'],
      ]
    )
    expect(csv).toBe('a,b\r\n1,2\r\n3,4')
  })

  it('escapes header and cell values', () => {
    const csv = toCsv(['=h'], [['=v']])
    expect(csv).toBe("'=h\r\n'=v")
  })

  it('renders empty rows as just the header', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b')
  })

  it('renders null cells as empty fields', () => {
    expect(toCsv(['a', 'b'], [[null, 'x']])).toBe('a,b\r\n,x')
  })
})
