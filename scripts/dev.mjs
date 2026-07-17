import { spawn } from 'node:child_process'

const commands = [
  ['API', ['run', 'dev:api']],
  ['WEB', ['run', 'dev:web']],
]

const children = commands.map(([label, args]) => {
  const windows = process.platform === 'win32'
  const command = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm'
  const commandArgs = windows ? ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`] : args
  const child = spawn(command, commandArgs, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  })
  child.stdout.on('data', (chunk) => process.stdout.write(`[${label}] ${chunk}`))
  child.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk}`))
  return child
})

const stop = () => {
  for (const child of children) child.kill()
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
