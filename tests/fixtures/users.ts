export const FIXTURE_USER_1 = {
  id: 'user1',
  walletAddress: 'GDZST3XVCDTUJ76ZAV2HA72KYXM4Y5KLTMPQWLBQ3VBLGR4A5YNWHA63',
  network: 'MAINNET' as const,
  displayName: 'Alice Mainnet',
  email: 'alice@example.com',
  avatarUrl: null,
  riskTolerance: 5,
  isActive: true,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
}

export const FIXTURE_USER_2 = {
  id: 'a1b2c3d4-0002-0002-0002-000000000002',
  walletAddress: 'GBVTL7V2M7XVMHG3MXVDNMKPQVKQRR5VR6VMXKXHXVYVRXLC3QXQZZY',
  network: 'MAINNET' as const,
  displayName: 'Bob Mainnet',
  email: 'bob@example.com',
  avatarUrl: null,
  riskTolerance: 3,
  isActive: true,
  createdAt: new Date('2024-01-02T00:00:00Z'),
  updatedAt: new Date('2024-01-02T00:00:00Z'),
}

export const FIXTURE_USER_TESTNET = {
  id: 'a1b2c3d4-0003-0003-0003-000000000003',
  walletAddress: 'GDTESTNETADDRESS1111111111111111111111111111111111111111',
  network: 'TESTNET' as const,
  displayName: 'Testnet User',
  email: 'testnet@example.com',
  avatarUrl: null,
  riskTolerance: 5,
  isActive: true,
  createdAt: new Date('2024-01-03T00:00:00Z'),
  updatedAt: new Date('2024-01-03T00:00:00Z'),
}

export function makeUser(overrides: Partial<typeof FIXTURE_USER_1> = {}) {
  return { ...FIXTURE_USER_1, ...overrides }
}
