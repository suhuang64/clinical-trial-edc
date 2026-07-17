import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createServer } from 'vite'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const webRoot = resolve(projectRoot, 'apps/web')

const server = await createServer({
  root: webRoot,
  configFile: resolve(webRoot, 'vite.config.ts'),
  logLevel: 'warn',
})

let exitCode

try {
  await server.listen()

  exitCode = await new Promise((resolveExit, reject) => {
    const runner = spawn(
      process.execPath,
      [
        resolve(projectRoot, 'node_modules/@playwright/test/cli.js'),
        'test',
        ...process.argv.slice(2),
      ],
      {
        cwd: projectRoot,
        env: { ...process.env, PLAYWRIGHT_EXTERNAL_SERVER: '1' },
        stdio: 'inherit',
        windowsHide: true,
      },
    )

    runner.once('error', reject)
    runner.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Playwright 被信号 ${signal} 中止`))
      else resolveExit(code ?? 1)
    })
  })
} finally {
  await server.close()
}

process.exitCode = exitCode
