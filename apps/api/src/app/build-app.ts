import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import multipart from '@fastify/multipart'
import staticFiles from '@fastify/static'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { config } from '../config.js'
import { authRoutes } from '../modules/auth/routes.js'
import { studyRoutes } from '../modules/studies/routes.js'
import {
  formRoutes,
  recoverFormMigrationJobs,
  waitForFormMigrationJobs,
} from '../modules/forms/routes.js'
import { subjectRoutes } from '../modules/subjects/routes.js'
import { randomizationRoutes } from '../modules/randomization/routes.js'
import { memberRoutes } from '../modules/members/routes.js'
import { recordRoutes } from '../modules/records/routes.js'
import { fileRoutes, recoverQuarantinedFiles } from '../modules/files/routes.js'
import { subjectEventRoutes } from '../modules/events/routes.js'
import { dashboardRoutes } from '../modules/dashboard/routes.js'
import { exportRoutes, recoverExportJobs, waitForExportJobs } from '../modules/exports/routes.js'
import { auditRoutes } from '../modules/audit/routes.js'
import { userRoutes } from '../modules/users/routes.js'

async function registerProductionWeb(app: FastifyInstance) {
  if (!config.isProduction) return

  const assetRoot = resolve(config.webDistRoot, 'assets')
  if (!existsSync(resolve(config.webDistRoot, 'index.html')) || !existsSync(assetRoot)) {
    throw new Error(`未找到前端生产构建文件，请先执行 npm run build：${config.webDistRoot}`)
  }

  await app.register(staticFiles, {
    root: assetRoot,
    prefix: '/assets/',
    maxAge: '1y',
    immutable: true,
  })

  await app.register(staticFiles, {
    root: config.webDistRoot,
    prefix: '/',
    decorateReply: false,
    wildcard: false,
    index: false,
    globIgnore: ['assets/**', 'index.html'],
  })

  const sendIndex = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply
      .header('Cache-Control', 'no-cache')
      .type('text/html; charset=utf-8')
      .sendFile('index.html', config.webDistRoot, { cacheControl: false })

  app.get('/', sendIndex)
  app.get('/*', async (request, reply) => {
    const requestPath = request.url?.split('?')[0] ?? ''
    if (requestPath.startsWith('/api/')) {
      return reply.code(404).send({ code: 'NOT_FOUND', message: '接口不存在' })
    }
    return sendIndex(request, reply)
  })
}

export async function buildApp() {
  const app = Fastify({
    logger: true,
    trustProxy: config.trustProxy,
    genReqId: () => crypto.randomUUID(),
  })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  await app.register(helmet, { contentSecurityPolicy: config.isProduction })
  await app.register(cookie)
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } })
  await app.register(rateLimit, { global: false })
  await app.register(swagger, {
    openapi: { info: { title: 'OpenEDC API', version: '1.0.0' } },
  })
  await app.register(swaggerUi, { routePrefix: '/documentation' })

  app.get('/api/health', async () => ({ status: 'ok', time: new Date().toISOString() }))
  await app.register(authRoutes, { prefix: '/api/v1/auth' })
  await app.register(studyRoutes, { prefix: '/api/v1/studies' })
  await app.register(formRoutes, { prefix: '/api/v1/studies/:studyId/forms' })
  await app.register(subjectRoutes, { prefix: '/api/v1/studies/:studyId/subjects' })
  await app.register(randomizationRoutes, { prefix: '/api/v1/studies/:studyId/randomization' })
  await app.register(memberRoutes, { prefix: '/api/v1/studies/:studyId/members' })
  await app.register(recordRoutes, {
    prefix: '/api/v1/studies/:studyId/subjects/:subjectId/records',
  })
  await app.register(fileRoutes, {
    prefix: '/api/v1/studies/:studyId/subjects/:subjectId/files',
  })
  await app.register(subjectEventRoutes, {
    prefix: '/api/v1/studies/:studyId/subjects/:subjectId/events',
  })
  await app.register(dashboardRoutes, { prefix: '/api/v1/studies/:studyId/dashboard' })
  await app.register(exportRoutes, { prefix: '/api/v1/studies/:studyId/exports' })
  await app.register(auditRoutes, { prefix: '/api/v1/studies/:studyId/audit' })
  await app.register(userRoutes, { prefix: '/api/v1/users' })
  await registerProductionWeb(app)
  recoverQuarantinedFiles()
  recoverFormMigrationJobs()
  recoverExportJobs()
  app.addHook('onClose', async () => {
    await Promise.all([waitForFormMigrationJobs(), waitForExportJobs()])
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(error)
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500
    return reply.code(status).send({
      code: status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
      message: status === 500 ? '服务器处理请求时发生错误' : error.message,
      requestId: request.id,
    })
  })
  return app
}
