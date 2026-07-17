import { buildApp } from './app/build-app.js'
import { config } from './config.js'
import { closeDatabase } from './db/database.js'

const app = await buildApp()

const shutdown = async () => {
  await app.close()
  await closeDatabase()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.error(error)
  await closeDatabase()
  process.exit(1)
}
