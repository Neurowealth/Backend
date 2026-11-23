/**
 * Unit tests for the DATABASE_URL / DB_* consistency check (#800).
 *
 * The quickstart failed because .env.example described one role in
 * DATABASE_URL and another in DB_USER. These tests pin the pure check that
 * now runs in `npm run env:parity` so the two can never drift again, and also
 * assert the values actually shipped in the repository are self-consistent.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  checkDatabaseUrlConsistency,
  parseEnvValues,
  type EnvParityIssue,
} from '../../../src/config/envParity'

const ROOT = path.resolve(__dirname, '../../..')

function consistentEnv(overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    DATABASE_URL: 'postgresql://postgres:password@localhost:5432/neuro_backend',
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_USER: 'postgres',
    DB_PASSWORD: 'password',
    DB_NAME: 'neuro_backend',
  }
  return Object.entries({ ...base, ...overrides })
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

function kindsFor(issues: EnvParityIssue[]): string[] {
  return issues.map((i) => `${i.key}:${i.severity}`)
}

describe('parseEnvValues', () => {
  it('extracts key/value pairs and ignores comments and blank lines', () => {
    const values = parseEnvValues(
      '# comment\n\nDB_USER=postgres\n  DB_NAME = neuro_backend  \nNO_EQUALS'
    )
    expect(values).toEqual({
      DB_USER: 'postgres',
      DB_NAME: 'neuro_backend',
    })
  })

  it('strips matching quotes around values', () => {
    const values = parseEnvValues('DB_PASSWORD="p ass"\nDB_USER=\'postgres\'')
    expect(values.DB_PASSWORD).toBe('p ass')
    expect(values.DB_USER).toBe('postgres')
  })
})

describe('checkDatabaseUrlConsistency (#800)', () => {
  it('reports no issues when DATABASE_URL matches every DB_* value', () => {
    expect(
      checkDatabaseUrlConsistency({ '.env.example': consistentEnv() })
    ).toEqual([])
  })

  it.each([
    ['DB_USER', 'other', 'user'],
    ['DB_PASSWORD', 'other', 'password'],
    ['DB_HOST', 'db.internal', 'host'],
    ['DB_PORT', '5433', 'port'],
    ['DB_NAME', 'other_db', 'database'],
  ])('flags a %s mismatch as an error', (key, value, label) => {
    const issues = checkDatabaseUrlConsistency({
      '.env.development': consistentEnv({ [key]: value }),
    })
    expect(kindsFor(issues)).toEqual([`${key}:error`])
    expect(issues[0].message).toContain(label)
    expect(issues[0].kind).toBe('database-url-mismatch')
  })

  it('flags all mismatching components in one file', () => {
    const issues = checkDatabaseUrlConsistency({
      '.env.example': consistentEnv({ DB_USER: 'user', DB_PORT: '5433' }),
    })
    expect(kindsFor(issues)).toEqual(['DB_USER:error', 'DB_PORT:error'])
  })

  it('skips files that have no DB_* values to compare', () => {
    const issues = checkDatabaseUrlConsistency({
      '.env.test': 'DATABASE_URL=postgresql://user:pass@localhost:5432/test',
    })
    expect(issues).toEqual([])
  })

  it('skips files with no DATABASE_URL or an unparseable one', () => {
    const issues = checkDatabaseUrlConsistency({
      'no-url.env': 'DB_USER=postgres\nDB_NAME=neuro_backend',
      'bad-url.env': 'DATABASE_URL=not-a-url\nDB_USER=postgres',
    })
    expect(issues).toEqual([])
  })

  it('decodes URL-encoded credentials before comparing', () => {
    const issues = checkDatabaseUrlConsistency({
      '.env.example': consistentEnv({
        DATABASE_URL:
          'postgresql://postgres:p%40ss@localhost:5432/neuro_backend',
        DB_PASSWORD: 'p@ss',
      }),
    })
    expect(issues).toEqual([])
  })

  it('treats an omitted URL port as the default 5432', () => {
    const issues = checkDatabaseUrlConsistency({
      '.env.example': consistentEnv({
        DATABASE_URL: 'postgresql://postgres:password@localhost/neuro_backend',
      }),
    })
    expect(issues).toEqual([])
  })

  it('finds no inconsistency in the env files shipped in this repository', () => {
    const files: Record<string, string> = {}
    for (const name of [
      '.env.example',
      '.env.development',
      '.env.production',
      '.env.test',
    ]) {
      files[name] = fs.readFileSync(path.join(ROOT, name), 'utf8')
    }
    expect(checkDatabaseUrlConsistency(files)).toEqual([])
  })
})
