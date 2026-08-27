/**
 * Wallet-encryption key registry unit tests (#323).
 *
 * The registry never stores key material — only a label and a SHA-256 hash —
 * so the properties that matter are: hashing is deterministic, registration
 * is idempotent under both a clean lookup-miss and a concurrent create race,
 * and status transitions (retire/compromise) write what they claim to.
 */

const mockFindUnique = jest.fn()
const mockCreate = jest.fn()
const mockFindMany = jest.fn()
const mockUpdate = jest.fn()

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    walletEncryptionKey: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}))

import {
  hashKey,
  deriveBootstrapLabel,
  findKeyByHash,
  findKeyById,
  listKeys,
  getOrRegisterKey,
  retireKey,
  markCompromised,
} from '../../../src/keys/registry'

const KEY_A = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
const KEY_B = 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3'

beforeEach(() => {
  jest.clearAllMocks()
})

describe('hashKey', () => {
  it('is deterministic for the same key', () => {
    expect(hashKey(KEY_A)).toBe(hashKey(KEY_A))
  })

  it('produces different hashes for different keys', () => {
    expect(hashKey(KEY_A)).not.toBe(hashKey(KEY_B))
  })

  it('never leaks the key material back out (produces a fixed-length hex digest, not the key)', () => {
    const hash = hashKey(KEY_A)
    expect(hash).not.toContain(KEY_A)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('deriveBootstrapLabel', () => {
  it('is deterministic and does not encode the key itself', () => {
    const label = deriveBootstrapLabel(KEY_A)
    expect(label).toBe(deriveBootstrapLabel(KEY_A))
    expect(label).not.toContain(KEY_A)
    expect(label.startsWith('bootstrap-')).toBe(true)
  })

  it('differs for different keys', () => {
    expect(deriveBootstrapLabel(KEY_A)).not.toBe(deriveBootstrapLabel(KEY_B))
  })
})

describe('findKeyByHash / findKeyById / listKeys', () => {
  it('looks up by hash', async () => {
    mockFindUnique.mockResolvedValue({ id: 'k1', hash: hashKey(KEY_A) })
    const result = await findKeyByHash(hashKey(KEY_A))
    expect(result).toEqual({ id: 'k1', hash: hashKey(KEY_A) })
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { hash: hashKey(KEY_A) },
    })
  })

  it('looks up by id', async () => {
    mockFindUnique.mockResolvedValue({ id: 'k1' })
    await findKeyById('k1')
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: 'k1' } })
  })

  it('lists keys ordered by createdAt ascending', async () => {
    mockFindMany.mockResolvedValue([])
    await listKeys()
    expect(mockFindMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'asc' },
    })
  })
})

describe('getOrRegisterKey', () => {
  it('rejects a key that is not 64 hex characters', async () => {
    await expect(getOrRegisterKey('short', 'label')).rejects.toThrow(
      '64 hexadecimal characters'
    )
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns the existing row when the key is already registered (by hash)', async () => {
    const existing = { id: 'existing-id', hash: hashKey(KEY_A) }
    mockFindUnique.mockResolvedValue(existing)

    const result = await getOrRegisterKey(KEY_A, 'some-label')

    expect(result).toBe(existing)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('creates a new row when the key is not yet registered', async () => {
    mockFindUnique.mockResolvedValue(null)
    mockCreate.mockResolvedValue({ id: 'new-id', hash: hashKey(KEY_A) })

    const result = await getOrRegisterKey(KEY_A, 'v1', 'ACTIVE')

    expect(result).toEqual({ id: 'new-id', hash: hashKey(KEY_A) })
    expect(mockCreate).toHaveBeenCalledWith({
      data: { keyLabel: 'v1', hash: hashKey(KEY_A), status: 'ACTIVE' },
    })
  })

  it('defaults status to ACTIVE when not specified', async () => {
    mockFindUnique.mockResolvedValue(null)
    mockCreate.mockResolvedValue({ id: 'new-id' })

    await getOrRegisterKey(KEY_A, 'v1')

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'ACTIVE' }),
      })
    )
  })

  it('recovers from a concurrent-create race by re-reading the winning row', async () => {
    const winner = { id: 'winner-id', hash: hashKey(KEY_A) }
    // First lookup misses (both callers race past it), create fails on the
    // unique hash constraint, second lookup finds the row the other caller won.
    mockFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(winner)
    mockCreate.mockRejectedValue(new Error('Unique constraint failed on hash'))

    const result = await getOrRegisterKey(KEY_A, 'v1')

    expect(result).toBe(winner)
  })

  it('rethrows if create fails and no row exists on re-read (a real error, not a race)', async () => {
    mockFindUnique.mockResolvedValue(null)
    mockCreate.mockRejectedValue(new Error('connection lost'))

    await expect(getOrRegisterKey(KEY_A, 'v1')).rejects.toThrow(
      'connection lost'
    )
  })
})

describe('retireKey / markCompromised', () => {
  it('retireKey sets status RETIRED and stamps retiredAt', async () => {
    mockUpdate.mockResolvedValue({ id: 'k1', status: 'RETIRED' })
    await retireKey('k1')
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { status: 'RETIRED', retiredAt: expect.any(Date) },
    })
  })

  it('markCompromised sets status COMPROMISED', async () => {
    mockUpdate.mockResolvedValue({ id: 'k1', status: 'COMPROMISED' })
    await markCompromised('k1')
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { status: 'COMPROMISED' },
    })
  })
})
