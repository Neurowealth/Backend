import db from '../../../src/db'
import { runSignerRotationCheck } from '../../../src/jobs/signerRotation'
import { initiateRotation } from '../../../src/treasury/signerRotation'

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: {
    treasuryAccount: { findFirst: jest.fn() },
    signerRotation: { findFirst: jest.fn() },
  },
}))
jest.mock('../../../src/treasury/signerRotation', () => ({
  initiateRotation: jest.fn(),
}))
jest.mock('../../../src/utils/metrics', () => ({
  stellarSignerRotationOverdueDays: { set: jest.fn() },
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockDb = db as any
const mockedInitiate = initiateRotation as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  delete process.env.STELLAR_NEXT_AGENT_PUBLIC_KEY
  mockDb.treasuryAccount.findFirst.mockResolvedValue({
    id: 'hot-1',
    publicKey: 'GOLD',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  })
  mockDb.signerRotation.findFirst.mockResolvedValue(null)
})

it('proposes a due rotation through the existing dual-active path', async () => {
  process.env.STELLAR_NEXT_AGENT_PUBLIC_KEY = 'GNEW'
  await runSignerRotationCheck(new Date('2026-04-15T00:00:00Z'))
  expect(mockedInitiate).toHaveBeenCalledWith(
    'hot-1',
    'GOLD',
    'GNEW',
    'scheduled-quarterly-rotation'
  )
})

it('does not create a second proposal during a dual-active window', async () => {
  process.env.STELLAR_NEXT_AGENT_PUBLIC_KEY = 'GNEW'
  mockDb.signerRotation.findFirst.mockResolvedValue({
    status: 'DUAL_ACTIVE',
    createdAt: new Date('2026-04-01T00:00:00Z'),
  })
  await runSignerRotationCheck(new Date('2026-05-01T00:00:00Z'))
  expect(mockedInitiate).not.toHaveBeenCalled()
})
