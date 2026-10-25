const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '../..')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'scripts'))
  fs.mkdirSync(path.join(dir, 'bin'))
  for (const name of [
    'release-preflight.sh',
    'release-verify.sh',
    'release-health-check.cjs',
  ]) {
    fs.copyFileSync(
      path.join(root, 'scripts', name),
      path.join(dir, 'scripts', name)
    )
  }
  const executable = (name, content) =>
    fs.writeFileSync(path.join(dir, 'bin', name), content, { mode: 0o755 })
  executable('git', '#!/bin/sh\nprintf "%s" "$DIRTY"\n')
  for (const name of ['npm', 'npx']) {
    executable(
      name,
      '#!/bin/sh\necho "$*" >> "$CALL_LOG"\n[ "$*" != "$FAIL_COMMAND" ]\n'
    )
  }
  fs.writeFileSync(
    path.join(dir, 'scripts/check-migration-rollback.sh'),
    'exit "${ROLLBACK_EXIT:-0}"\n'
  )
  executable(
    'curl',
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const url = args.at(-1);
fs.appendFileSync(process.env.CALL_LOG, url + '\\n');
if (process.env.TRANSPORT_FAIL) process.exit(28);
const kind = url.endsWith('/deep') ? 'deep' : url.endsWith('/ready') ? 'ready' : 'live';
if (kind === 'deep' && !args.includes('--header')) process.exit(2);
fs.writeFileSync(args[args.indexOf('--output') + 1], JSON.parse(process.env.BODIES)[kind]);
process.stdout.write(process.env.HTTP_CODE || '200');
`
  )
  const env = {
    ...process.env,
    PATH: `${dir}/bin:${process.env.PATH}`,
    CALL_LOG: `${dir}/calls`,
    INTERNAL_SERVICE_TOKEN: 'test-token',
    DIRTY: '',
    FAIL_COMMAND: '',
  }
  return {
    run(script, overrides = {}) {
      return spawnSync('bash', [path.join(dir, 'scripts', script)], {
        env: { ...env, ...overrides },
        encoding: 'utf8',
      })
    },
    calls() {
      return fs.existsSync(env.CALL_LOG)
        ? fs.readFileSync(env.CALL_LOG, 'utf8')
        : ''
    },
  }
}

const commands = [
  'run env:parity',
  'run format:check',
  'run lint',
  'run typecheck',
  'run validate:spec',
  '--no-install prisma migrate status',
  'test -- --runInBand --watchman=false',
  'run build',
]
for (const command of commands) {
  test(`preflight stops at failed ${command}`, (t) => {
    const f = fixture(t)
    assert.notEqual(
      f.run('release-preflight.sh', { FAIL_COMMAND: command }).status,
      0
    )
    assert.equal(f.calls().trim().split('\n').at(-1), command)
  })
}
test('preflight rejects dirty workspace before running checks', (t) => {
  const f = fixture(t)
  assert.notEqual(f.run('release-preflight.sh', { DIRTY: '?? file' }).status, 0)
  assert.equal(f.calls(), '')
})
test('preflight rejects missing rollback files', (t) => {
  const f = fixture(t)
  assert.notEqual(
    f.run('release-preflight.sh', { ROLLBACK_EXIT: '1' }).status,
    0
  )
  assert.ok(!f.calls().includes('run build'))
})
test('preflight passes only when all checks pass', (t) => {
  const f = fixture(t)
  assert.equal(f.run('release-preflight.sh').status, 0)
  assert.deepEqual(f.calls().trim().split('\n'), commands)
})

const healthy = {
  live: JSON.stringify({ status: 'ok' }),
  ready: JSON.stringify({
    ready: true,
    subsystems: {
      eventListener: true,
      agentLoop: true,
      database: true,
      stellarNetwork: true,
    },
  }),
  deep: JSON.stringify({
    status: 'healthy',
    checks: Object.fromEntries(
      ['database', 'stellarRpc', 'twilio', 'agentLoop'].map((name) => [
        name,
        { status: 'healthy' },
      ])
    ),
  }),
}
for (const [name, overrides] of [
  ['missing token', { INTERNAL_SERVICE_TOKEN: '' }],
  ['transport failure', { TRANSPORT_FAIL: '1' }],
  ['HTTP failure', { HTTP_CODE: '503' }],
  ['redirect', { HTTP_CODE: '302' }],
  [
    'malformed JSON',
    { BODIES: JSON.stringify({ ...healthy, live: '<html>OK</html>' }) },
  ],
  [
    'not ready',
    { BODIES: JSON.stringify({ ...healthy, ready: '{"ready":false}' }) },
  ],
  [
    'missing subsystems',
    { BODIES: JSON.stringify({ ...healthy, ready: '{"ready":true}' }) },
  ],
  [
    'unhealthy despite HTTP 200',
    { BODIES: JSON.stringify({ ...healthy, deep: '{"status":"unhealthy"}' }) },
  ],
  [
    'missing dependency checks',
    { BODIES: JSON.stringify({ ...healthy, deep: '{"status":"healthy"}' }) },
  ],
  [
    'degraded dependency',
    {
      BODIES: JSON.stringify({
        ...healthy,
        deep: healthy.deep.replaceAll('healthy', 'degraded'),
      }),
    },
  ],
]) {
  test(`verification rejects ${name}`, (t) => {
    const f = fixture(t)
    const result = f.run('release-verify.sh', {
      BODIES: JSON.stringify(healthy),
      ...overrides,
    })
    assert.notEqual(result.status, 0)
    assert.ok(!(result.stdout + result.stderr).includes('test-token'))
  })
}
test('verification accepts healthy API responses and uses existing endpoints', (t) => {
  const f = fixture(t)
  const result = f.run('release-verify.sh', { BODIES: JSON.stringify(healthy) })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(f.calls().trim().split('\n'), [
    'http://localhost:3000/health',
    'http://localhost:3000/health/ready',
    'http://localhost:3000/health/deep',
  ])
})
