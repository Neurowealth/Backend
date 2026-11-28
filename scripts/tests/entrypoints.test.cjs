const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '../..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

// Pull file paths (dist/*.js, src/*.ts) out of a script or `main` value.
function referencedPaths(value) {
  return value.match(/(?:dist|src)\/[\w./-]+\.(?:js|ts)/g) || []
}

// A dist/X.js path is produced from src/X.ts (tsconfig.build.json rootDir is ./src).
function sourceFor(p) {
  return p.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')
}

const entries = {
  main: pkg.main,
  'scripts.start': pkg.scripts.start,
  'scripts.dev': pkg.scripts.dev,
}

for (const [name, value] of Object.entries(entries)) {
  test(`${name} references files that exist`, () => {
    const paths = referencedPaths(value)
    assert.ok(paths.length > 0, `${name} references no entry file: ${value}`)
    for (const p of paths) {
      const src = p.startsWith('dist/') ? sourceFor(p) : p
      assert.ok(
        fs.existsSync(path.join(root, src)),
        `${name} -> ${p}: source ${src} does not exist`
      )
      // After `npm run build` the compiled file must exist too.
      if (p.startsWith('dist/') && fs.existsSync(path.join(root, 'dist'))) {
        assert.ok(
          fs.existsSync(path.join(root, p)),
          `${name} -> ${p} is not produced by the build`
        )
      }
    }
  })
}

test('main, start and dev all target the real API entrypoint', () => {
  assert.equal(pkg.main, 'dist/index.js')
  assert.match(pkg.scripts.start, /dist\/index\.js/)
  assert.match(pkg.scripts.dev, /src\/index\.ts/)
  assert.equal(fs.existsSync(path.join(root, 'src/app.ts')), false)
})
