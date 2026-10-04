// Validate the health API contract without printing response bodies or credentials.
const fs = require('node:fs')
const [kind, bodyFile] = process.argv.slice(2)
try {
  const body = JSON.parse(fs.readFileSync(bodyFile, 'utf8'))
  let valid = false
  if (kind === 'live') valid = body.status === 'ok'
  if (kind === 'ready') {
    const names = ['eventListener', 'agentLoop', 'database', 'stellarNetwork']
    valid =
      body.ready === true &&
      names.every((name) => body.subsystems?.[name] === true)
  }
  if (kind === 'deep') {
    const names = ['database', 'stellarRpc', 'twilio', 'agentLoop']
    valid =
      body.status === 'healthy' &&
      names.every((name) => body.checks?.[name]?.status === 'healthy')
  }
  process.exitCode = valid ? 0 : 1
} catch {
  process.exitCode = 1
}
