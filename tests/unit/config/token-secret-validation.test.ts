const tokenModules = [
  '../../../src/middleware/impersonation',
  '../../../src/middleware/streamAuth',
  '../../../src/utils/ackToken',
]

describe('token signing secret configuration', () => {
  let originalNodeEnv: string | undefined
  let originalJwtSeed: string | undefined

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV
    originalJwtSeed = process.env.JWT_SEED
    process.env.NODE_ENV = 'production'
    delete process.env.JWT_SEED
  })

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv

    if (originalJwtSeed === undefined) delete process.env.JWT_SEED
    else process.env.JWT_SEED = originalJwtSeed
  })

  it.each(tokenModules)(
    'refuses to import %s when JWT_SEED is missing in production',
    (modulePath) => {
      jest.isolateModules(() => {
        expect(() => require(modulePath)).toThrow(/JWT_SEED/)
      })
    }
  )
})
