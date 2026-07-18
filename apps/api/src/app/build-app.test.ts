import { existsSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

const workspaceRoot = resolve(import.meta.dirname, '../../../../')
const databaseRelativePath = `storage/data/api-test-${randomUUID()}.sqlite`
const databasePath = resolve(workspaceRoot, databaseRelativePath)
const fileTestId = randomUUID()
const uploadRelativePath = `storage/uploads/api-test-${fileTestId}`
const quarantineRelativePath = `storage/quarantine/api-test-${fileTestId}`
const exportRelativePath = `storage/exports/api-test-${fileTestId}`
const uploadPath = resolve(workspaceRoot, uploadRelativePath)
const quarantinePath = resolve(workspaceRoot, quarantineRelativePath)
const exportPath = resolve(workspaceRoot, exportRelativePath)
let app: FastifyInstance | undefined
let closeDatabase: (() => Promise<void>) | undefined
let sessionCookie = ''
let csrfToken = ''
let testUserSequence = 0
const successfulMutationRequests: Array<{ id: string; method: string; url: string }> = []

async function createPlatformUser(
  headers: Record<string, string>,
  username: string,
  displayName: string,
  initialPassword: string,
  profile: {
    gender?: 'male' | 'female' | 'other' | 'undisclosed'
    birthDate?: string
    organization?: string
  } = {},
) {
  testUserSequence += 1
  const response = await app!.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers,
    payload: {
      username,
      displayName,
      gender: profile.gender ?? 'undisclosed',
      birthDate: profile.birthDate ?? '1980-01-01',
      phone: `+1555${String(testUserSequence).padStart(7, '0')}`,
      email: `${username}@example.test`,
      organization: profile.organization ?? '集成测试单位',
      initialPassword,
    },
  })
  if (response.statusCode !== 201)
    throw new Error(`Failed to create platform user ${username}: ${response.body}`)
  return response.json().id as string
}

async function waitForExport(studyId: string, exportId: string, headers: Record<string, string>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/exports`,
      headers,
    })
    const job = response.json().items.find((item: { id: string }) => item.id === exportId)
    if (job?.status === 'completed') return job
    if (job?.status === 'failed') throw new Error(`Export job failed: ${job.errorMessage}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Export job timed out: ${exportId}`)
}

async function waitForMigration(
  studyId: string,
  formId: string,
  jobId: string,
  headers: Record<string, string>,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/forms/${formId}/migrations`,
      headers,
    })
    const job = response.json().items.find((item: { id: string }) => item.id === jobId)
    if (job?.status === 'completed') return job
    if (job?.status === 'failed') throw new Error(`Migration job failed: ${job.error_message}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Migration job timed out: ${jobId}`)
}

beforeAll(async () => {
  process.env.DATABASE_PATH = databaseRelativePath
  process.env.UPLOAD_ROOT = uploadRelativePath
  process.env.QUARANTINE_ROOT = quarantineRelativePath
  process.env.EXPORT_ROOT = exportRelativePath
  const [{ buildApp }, database, auth] = await Promise.all([
    import('./build-app.js'),
    import('../db/database.js'),
    import('../auth/auth.js'),
  ])
  closeDatabase = database.closeDatabase
  const now = new Date().toISOString()
  const userId = randomUUID()
  await database.db
    .insertInto('users')
    .values({
      id: userId,
      username: 'integration-admin',
      display_name: '集成测试管理员',
      password_hash: await auth.hashPassword('Integration-Test-Password-2026'),
      is_system_admin: 1,
      status: 'active',
      failed_login_count: 0,
      locked_until: null,
      locale: 'zh-CN',
      theme: 'system',
      created_at: now,
      updated_at: now,
    })
    .execute()
  const session = await auth.createSession(userId)
  sessionCookie = `edc_session=${session.token}`
  csrfToken = session.csrfToken
  app = await buildApp()
  app.addHook('onResponse', async (request, reply) => {
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      reply.statusCode >= 200 &&
      reply.statusCode < 300
    ) {
      successfulMutationRequests.push({
        id: request.id,
        method: request.method,
        url: request.url.split('?')[0]!,
      })
    }
  })
}, 60_000)

afterAll(async () => {
  if (app) await app.close()
  if (closeDatabase) await closeDatabase()
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${databasePath}${suffix}`
    if (existsSync(path)) rmSync(path)
  }
  for (const path of [uploadPath, quarantinePath, exportPath]) {
    if (existsSync(path) && path.startsWith(workspaceRoot)) rmSync(path, { recursive: true })
  }
})

describe('API 基础能力', () => {
  it('返回健康状态', async () => {
    const response = await app!.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json().status).toBe('ok')
  })

  it('管理员可以登录并获得 HttpOnly 会话', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'integration-admin', password: 'Integration-Test-Password-2026' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().csrfToken).toEqual(expect.any(String))
    expect(response.headers['set-cookie']).toContain('HttpOnly')
  })

  it('错误密码产生统一错误响应', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'integration-admin', password: 'wrong-password' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' })
  })

  it('支持包含身份资料的注册与超级管理员审核', async () => {
    const registration = await app!.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        username: 'self-registered-user',
        displayName: '同名研究人员',
        gender: 'female',
        birthDate: '1988-06-15',
        phone: '+8613800000001',
        email: 'self-registered@example.test',
        organization: '注册测试医院',
        password: 'Self-Registration-Password-2026!',
        confirmPassword: 'Self-Registration-Password-2026!',
      },
    })
    expect(registration.statusCode).toBe(201)
    expect(registration.json().approvalStatus).toBe('pending')
    const pendingLogin = await app!.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        username: 'self-registered-user',
        password: 'Self-Registration-Password-2026!',
      },
    })
    expect(pendingLogin.statusCode).toBe(200)
    expect(pendingLogin.json().user.approvalStatus).toBe('pending')
    const headers = { cookie: sessionCookie, 'x-csrf-token': csrfToken }
    const pendingUsers = await app!.inject({
      method: 'GET',
      url: '/api/v1/users?approvalStatus=pending',
      headers,
    })
    expect(pendingUsers.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: registration.json().id,
          display_name: '同名研究人员',
          gender: 'female',
          birth_date: '1988-06-15',
          phone: '+8613800000001',
          email: 'self-registered@example.test',
          organization: '注册测试医院',
          approval_status: 'pending',
        }),
      ]),
    )
    const approval = await app!.inject({
      method: 'PUT',
      url: `/api/v1/users/${registration.json().id}/approval`,
      headers,
      payload: { approvalStatus: 'approved' },
    })
    expect(approval.statusCode).toBe(200)
    expect(approval.json().approvalStatus).toBe('approved')
  })

  it('超级管理员可以删除未加入研究的普通账号', async () => {
    const headers = { cookie: sessionCookie, 'x-csrf-token': csrfToken }
    const userId = await createPlatformUser(
      headers,
      'deletable-user',
      '可删除用户',
      'Deletable-User-Password-2026!',
    )
    const deletion = await app!.inject({
      method: 'DELETE',
      url: `/api/v1/users/${userId}`,
      headers,
    })
    expect(deletion.statusCode).toBe(204)
    const deletedUser = await app!.inject({
      method: 'GET',
      url: '/api/v1/users?query=deletable-user',
      headers,
    })
    expect(deletedUser.json().items).toHaveLength(0)
  })

  it('完成创建项目、中心、筛选、入组和简单随机化的垂直流程', async () => {
    const headers = { cookie: sessionCookie, 'x-csrf-token': csrfToken }
    const loginAudit = await app!.inject({
      method: 'GET',
      url: '/api/v1/users/login-audit',
      headers,
    })
    expect(loginAudit.statusCode).toBe(200)
    expect(loginAudit.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'auth.login_succeeded',
          attemptedUsername: 'integration-admin',
        }),
        expect.objectContaining({
          action: 'auth.login_failed',
          attemptedUsername: 'integration-admin',
        }),
      ]),
    )
    const updatePreferences = await app!.inject({
      method: 'PUT',
      url: '/api/v1/auth/preferences',
      headers,
      payload: { locale: 'en-US', theme: 'dark' },
    })
    expect(updatePreferences.statusCode).toBe(200)
    expect(updatePreferences.json().user).toMatchObject({ locale: 'en-US', theme: 'dark' })
    await app!.inject({
      method: 'PUT',
      url: '/api/v1/auth/preferences',
      headers,
      payload: { locale: 'zh-CN', theme: 'system' },
    })
    const studyResponse = await app!.inject({
      method: 'POST',
      url: '/api/v1/studies',
      headers,
      payload: { protocolCode: 'TEST-001', name: '集成测试研究', sponsor: '测试申办方' },
    })
    expect(studyResponse.statusCode).toBe(201)
    const studyId = studyResponse.json().id as string
    const siteResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/sites`,
      headers,
      payload: { name: '测试中心', enrollmentTarget: 100 },
    })
    expect(siteResponse.statusCode).toBe(201)
    const siteId = siteResponse.json().id as string
    let siteName = siteResponse.json().name as string
    const writeBeforeStart = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects`,
      headers,
      payload: { siteId, screeningData: {} },
    })
    expect(writeBeforeStart.statusCode).toBe(409)
    expect(writeBeforeStart.json().code).toBe('STUDY_NOT_ACTIVE')
    expect(
      (
        await app!.inject({
          method: 'POST',
          url: `/api/v1/studies/${studyId}/status`,
          headers,
          payload: { status: 'active' },
        })
      ).statusCode,
    ).toBe(200)
    const updateSite = await app!.inject({
      method: 'PUT',
      url: `/api/v1/studies/${studyId}/sites/${siteId}`,
      headers,
      payload: {
        name: '测试中心（更新）',
        principalInvestigator: '张医生',
        contactName: '研究秘书',
        contactPhone: '010-12345678',
        contactEmail: 'site01@example.test',
        enrollmentTarget: 120,
      },
    })
    expect(updateSite.statusCode).toBe(200)
    siteName = updateSite.json().name as string

    const numberingConfiguration = {
      screening: { prefix: 'PRE-', padLength: 5 },
      subject: { prefix: 'PAT-', padLength: 6 },
      randomization: { prefix: 'RND-', padLength: 4 },
    }
    const saveNumbering = await app!.inject({
      method: 'PUT',
      url: `/api/v1/studies/${studyId}/counters`,
      headers,
      payload: numberingConfiguration,
    })
    expect(saveNumbering.statusCode).toBe(200)
    const getNumbering = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/counters`,
      headers,
    })
    expect(getNumbering.statusCode).toBe(200)
    expect(getNumbering.json().counters).toMatchObject(numberingConfiguration)
    const numberingAudit = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/audit?action=study.numbering_updated`,
      headers,
    })
    expect(numberingAudit.statusCode).toBe(200)
    expect(numberingAudit.json().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'study.numbering_updated' })]),
    )

    const subjectResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects`,
      headers,
      payload: { siteId, screeningData: { diagnosis: '测试诊断' } },
    })
    expect(subjectResponse.statusCode).toBe(201)
    expect(subjectResponse.json().screeningNumber).toBe('PRE-00001')
    const subjectId = subjectResponse.json().id as string
    const subjectCreateAudit = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/audit?action=subject.screening_created`,
      headers,
    })
    expect(subjectCreateAudit.statusCode).toBe(200)
    expect(subjectCreateAudit.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'subject.screening_created',
          objectId: subjectId,
          createdAt: expect.stringMatching(/Z$/),
        }),
      ]),
    )

    const frozenNumbering = await app!.inject({
      method: 'PUT',
      url: `/api/v1/studies/${studyId}/counters`,
      headers,
      payload: {
        ...numberingConfiguration,
        screening: { prefix: 'CHANGED-', padLength: 5 },
      },
    })
    expect(frozenNumbering.statusCode).toBe(409)
    expect(frozenNumbering.json()).toMatchObject({
      code: 'COUNTER_RULE_FROZEN',
      details: { counterType: 'screening', currentValue: 1 },
    })

    const conclusionResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/conclusion`,
      headers,
      payload: { conclusion: 'eligible' },
    })
    expect(conclusionResponse.statusCode).toBe(200)

    const enrollResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/enroll`,
      headers,
    })
    expect(enrollResponse.statusCode).toBe(200)
    expect(enrollResponse.json().subjectNumber).toBe('PAT-000001')

    const boundary = `----edc-test-${randomUUID()}`
    const multipartPayload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="supporting-document.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 test document\r\n--${boundary}--\r\n`,
    )
    const uploadFile = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/files/supporting_document`,
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartPayload,
    })
    expect(uploadFile.statusCode).toBe(201)
    const fileId = uploadFile.json().id as string
    const listFiles = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/files`,
      headers,
    })
    expect(listFiles.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fileId, originalName: 'supporting-document.pdf' }),
      ]),
    )
    const downloadFile = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/files/${fileId}/download`,
      headers,
    })
    expect(downloadFile.statusCode).toBe(200)
    expect(downloadFile.headers['content-disposition']).toContain('supporting-document.pdf')
    const deleteFile = await app!.inject({
      method: 'DELETE',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/files/${fileId}`,
      headers,
    })
    expect(deleteFile.statusCode).toBe(204)
    const filesAfterDelete = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/files`,
      headers,
    })
    expect(filesAfterDelete.json().items).toHaveLength(0)
    expect(
      existsSync(uploadPath)
        ? readdirSync(uploadPath, { recursive: true }).filter((path) =>
            /\.[a-z0-9]+$/i.test(String(path)),
          )
        : [],
    ).toHaveLength(0)
    expect(existsSync(uploadPath) ? readdirSync(uploadPath, { recursive: true }) : []).toHaveLength(
      0,
    )

    const missingBoundary = `----edc-missing-file-${randomUUID()}`
    const missingPayload = Buffer.from(
      `--${missingBoundary}\r\nContent-Disposition: form-data; name="file"; filename="missing-storage.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 missing storage test\r\n--${missingBoundary}--\r\n`,
    )
    const missingUpload = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/files/supporting_document`,
      headers: {
        ...headers,
        'content-type': `multipart/form-data; boundary=${missingBoundary}`,
      },
      payload: missingPayload,
    })
    expect(missingUpload.statusCode).toBe(201)
    const missingFileId = missingUpload.json().id as string
    const storedRelativePath = readdirSync(uploadPath, { recursive: true }).find((path) =>
      String(path).endsWith('.pdf'),
    )
    expect(storedRelativePath).toBeDefined()
    const storedAbsolutePath = resolve(uploadPath, String(storedRelativePath))
    const subjectUploadDirectory = dirname(storedAbsolutePath)
    unlinkSync(storedAbsolutePath)
    expect(existsSync(subjectUploadDirectory)).toBe(true)
    const deleteMissingFile = await app!.inject({
      method: 'DELETE',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/files/${missingFileId}`,
      headers,
    })
    expect(deleteMissingFile.statusCode).toBe(204)
    const filesAfterMissingDelete = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/files`,
      headers,
    })
    expect(filesAfterMissingDelete.json().items).toHaveLength(0)
    expect(existsSync(subjectUploadDirectory)).toBe(false)
    expect(existsSync(uploadPath) ? readdirSync(uploadPath, { recursive: true }) : []).toHaveLength(
      0,
    )

    const schemeResponse = await app!.inject({
      method: 'PUT',
      url: `/api/v1/studies/${studyId}/randomization/scheme`,
      headers,
      payload: {
        name: '1:1 简单随机',
        method: 'simple',
        arms: [
          { id: 'A', label: '治疗组 A', weight: 1 },
          { id: 'B', label: '治疗组 B', weight: 1 },
        ],
        config: {},
      },
    })
    expect(schemeResponse.statusCode).toBe(200)
    const simulationResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/randomization/scheme/simulate`,
      headers,
      payload: {
        name: '1:1 简单随机',
        method: 'simple',
        arms: [
          { id: 'A', label: '治疗组 A', weight: 1 },
          { id: 'B', label: '治疗组 B', weight: 1 },
        ],
        config: {},
        sampleSize: 200,
      },
    })
    expect(simulationResponse.statusCode).toBe(200)
    expect(
      simulationResponse
        .json()
        .results.reduce((sum: number, row: { count: number }) => sum + row.count, 0),
    ).toBe(200)
    expect(
      (
        await app!.inject({
          method: 'POST',
          url: `/api/v1/studies/${studyId}/randomization/scheme/activate`,
          headers,
        })
      ).statusCode,
    ).toBe(200)

    const randomizationContext = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/records/context`,
      headers,
    })
    expect(randomizationContext.statusCode).toBe(200)
    expect(randomizationContext.json()).toMatchObject({
      capabilities: { randomize: true },
      randomization: { status: 'active' },
    })

    const assignmentResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/randomization/subjects/${subjectId}/assign`,
      headers,
      payload: { factors: {} },
    })
    expect(assignmentResponse.statusCode).toBe(200)
    expect(assignmentResponse.json()).toMatchObject({ randomNumber: 'RND-0001' })
    const assignedArmId = assignmentResponse.json().armId as 'A' | 'B'
    expect(['A', 'B']).toContain(assignedArmId)
    const assignedArmLabel = assignedArmId === 'A' ? '治疗组 A' : '治疗组 B'

    const randomizedSubjectList = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/subjects`,
      headers,
    })
    expect(randomizedSubjectList.statusCode).toBe(200)
    expect(
      randomizedSubjectList.json().items.find((item: { id: string }) => item.id === subjectId),
    ).toMatchObject({
      randomization_arm_id: assignedArmId,
      randomization_arm_label: assignedArmLabel,
    })

    const randomizedSubjectDetail = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/records/context`,
      headers,
    })
    expect(randomizedSubjectDetail.statusCode).toBe(200)
    expect(randomizedSubjectDetail.json().subject).toMatchObject({
      randomization_arm_id: assignedArmId,
      randomization_arm_label: assignedArmLabel,
    })

    const duplicateResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/randomization/subjects/${subjectId}/assign`,
      headers,
      payload: { factors: {} },
    })
    expect(duplicateResponse.statusCode).toBe(200)
    expect(duplicateResponse.json().alreadyAssigned).toBe(true)
    const randomizedDelete = await app!.inject({
      method: 'DELETE',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}`,
      headers,
      payload: { reason: '随机化受试者删除保护测试' },
    })
    expect(randomizedDelete.statusCode).toBe(409)
    expect(randomizedDelete.json().code).toBe('RANDOMIZED_SUBJECT_DELETE_FORBIDDEN')

    const secondSiteResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/sites`,
      headers,
      payload: { name: '第二测试中心', enrollmentTarget: 50 },
    })
    const secondSiteId = secondSiteResponse.json().id as string
    const secondSiteName = secondSiteResponse.json().name as string
    const secondSubjectResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects`,
      headers,
      payload: { siteId: secondSiteId, screeningData: { diagnosis: '第二中心病例' } },
    })
    expect(secondSubjectResponse.statusCode).toBe(201)
    const secondSubjectId = secondSubjectResponse.json().id as string
    const subjectDeleteBoundary = `----edc-subject-file-${randomUUID()}`
    const subjectDeleteUpload = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${secondSubjectId}/files/screening_report`,
      headers: {
        ...headers,
        'content-type': `multipart/form-data; boundary=${subjectDeleteBoundary}`,
      },
      payload: Buffer.from(
        `--${subjectDeleteBoundary}\r\nContent-Disposition: form-data; name="file"; filename="delete-with-subject.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 delete with subject\r\n--${subjectDeleteBoundary}--\r\n`,
      ),
    })
    expect(subjectDeleteUpload.statusCode).toBe(201)
    const concurrentSubjectResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects`,
      headers,
      payload: { siteId: secondSiteId, screeningData: { diagnosis: '并发随机化测试' } },
    })
    const concurrentSubjectId = concurrentSubjectResponse.json().id as string
    await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${concurrentSubjectId}/conclusion`,
      headers,
      payload: { conclusion: 'eligible' },
    })
    await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${concurrentSubjectId}/enroll`,
      headers,
    })
    await app!.close()
    const { buildApp } = await import('./build-app.js')
    app = await buildApp()
    const concurrentAssignments = await Promise.all([
      app!.inject({
        method: 'POST',
        url: `/api/v1/studies/${studyId}/randomization/subjects/${concurrentSubjectId}/assign`,
        headers,
        payload: { factors: {} },
      }),
      app!.inject({
        method: 'POST',
        url: `/api/v1/studies/${studyId}/randomization/subjects/${concurrentSubjectId}/assign`,
        headers,
        payload: { factors: {} },
      }),
    ])
    expect(concurrentAssignments.every((response) => response.statusCode === 200)).toBe(true)
    expect(
      concurrentAssignments.filter((response) => response.json().alreadyAssigned === true),
    ).toHaveLength(1)
    expect(
      new Set(concurrentAssignments.map((response) => response.json().randomNumber)).size,
    ).toBe(1)
    expect(concurrentAssignments[0]!.json().randomNumber).toBe('RND-0002')

    const investigatorUserId = await createPlatformUser(
      headers,
      'site-investigator',
      '中心研究医生',
      'Investigator-Test-Password-2026',
      { gender: 'male', birthDate: '1981-02-03', organization: '第一测试医院' },
    )
    const sameNameUserId = await createPlatformUser(
      headers,
      'same-name-observer',
      '中心研究医生',
      'Same-Name-Observer-Password-2026!',
      { gender: 'female', birthDate: '1990-04-05', organization: '第二测试医院' },
    )
    const sameNameCandidates = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/members/candidates?name=${encodeURIComponent('中心研究医生')}`,
      headers,
    })
    expect(sameNameCandidates.statusCode).toBe(200)
    expect(sameNameCandidates.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: investigatorUserId,
          gender: 'male',
          organization: '第一测试医院',
        }),
        expect.objectContaining({
          id: sameNameUserId,
          gender: 'female',
          organization: '第二测试医院',
        }),
      ]),
    )
    const memberResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/members`,
      headers,
      payload: {
        userId: investigatorUserId,
        roleCode: 'investigator',
        siteId,
        overrides: [],
      },
    })
    expect(memberResponse.statusCode).toBe(201)
    const membershipId = memberResponse.json().id as string
    const memberUserId = memberResponse.json().userId as string
    const deleteMemberAccount = await app!.inject({
      method: 'DELETE',
      url: `/api/v1/users/${memberUserId}`,
      headers,
    })
    expect(deleteMemberAccount.statusCode).toBe(409)
    expect(deleteMemberAccount.json().code).toBe('USER_HAS_MEMBERSHIPS')
    const globalUsers = await app!.inject({ method: 'GET', url: '/api/v1/users', headers })
    expect(globalUsers.statusCode).toBe(200)
    expect(globalUsers.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: memberUserId, username: 'site-investigator' }),
      ]),
    )

    const permissionCatalog = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/members/permissions`,
      headers,
    })
    expect(permissionCatalog.statusCode).toBe(200)
    expect(permissionCatalog.json().grantableRoleCodes).toContain('study_admin')
    expect(permissionCatalog.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'randomization.manage',
          defaultRoleCodes: ['study_admin'],
        }),
      ]),
    )
    const projectAdminUserId = await createPlatformUser(
      headers,
      'project-administrator',
      '项目管理员',
      'Project-Administrator-Password-2026!',
    )
    const projectAdminMembership = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/members`,
      headers,
      payload: {
        userId: projectAdminUserId,
        roleCode: 'study_admin',
        siteId: null,
        overrides: [],
      },
    })
    expect(projectAdminMembership.statusCode).toBe(201)
    const projectAdminLogin = await app!.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        username: 'project-administrator',
        password: 'Project-Administrator-Password-2026!',
      },
    })
    const projectAdminHeaders = {
      cookie: String(projectAdminLogin.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': projectAdminLogin.json().csrfToken as string,
    }
    const projectAdminCatalog = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/members/permissions`,
      headers: projectAdminHeaders,
    })
    expect(projectAdminCatalog.json().grantableRoleCodes).not.toContain('study_admin')
    const forbiddenProjectAdminGrant = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/members`,
      headers: projectAdminHeaders,
      payload: {
        userId: sameNameUserId,
        roleCode: 'study_admin',
        siteId: null,
        overrides: [],
      },
    })
    expect(forbiddenProjectAdminGrant.statusCode).toBe(403)
    expect(forbiddenProjectAdminGrant.json().code).toBe('GRANT_SCOPE_EXCEEDED')

    const updateMember = await app!.inject({
      method: 'PUT',
      url: `/api/v1/studies/${studyId}/members/${membershipId}`,
      headers,
      payload: {
        roleCode: 'investigator',
        siteId,
        status: 'active',
        overrides: [{ permissionCode: 'subject.edit', effect: 'deny' }],
      },
    })
    expect(updateMember.statusCode).toBe(200)
    const memberList = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/members`,
      headers,
    })
    expect(memberList.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: membershipId,
          overrides: [{ permissionCode: 'subject.edit', effect: 'deny' }],
        }),
      ]),
    )

    const investigatorLogin = await app!.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'site-investigator', password: 'Investigator-Test-Password-2026' },
    })
    expect(investigatorLogin.statusCode).toBe(200)
    const investigatorHeaders = {
      cookie: String(investigatorLogin.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': investigatorLogin.json().csrfToken as string,
    }
    const isolationStudyResponse = await app!.inject({
      method: 'POST',
      url: '/api/v1/studies',
      headers,
      payload: { protocolCode: 'ISOLATION-002', name: '项目隔离验证研究' },
    })
    const isolationStudyId = isolationStudyResponse.json().id as string
    const isolationSiteResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${isolationStudyId}/sites`,
      headers,
      payload: { name: '隔离中心' },
    })
    const isolationSiteId = isolationSiteResponse.json().id as string
    const deniedOtherStudy = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${isolationStudyId}/subjects`,
      headers: investigatorHeaders,
    })
    expect(deniedOtherStudy.statusCode).toBe(403)
    expect(deniedOtherStudy.json().code).toBe('STUDY_ACCESS_DENIED')
    const crossStudySubjectReference = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${isolationStudyId}/subjects/${subjectId}`,
      headers,
    })
    expect(crossStudySubjectReference.statusCode).toBe(404)
    expect(crossStudySubjectReference.json().code).toBe('SUBJECT_NOT_FOUND')
    const crossStudySiteReference = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects`,
      headers,
      payload: { siteId: isolationSiteId, screeningData: {} },
    })
    expect(crossStudySiteReference.statusCode).toBe(404)
    expect(crossStudySiteReference.json().code).toBe('SITE_NOT_FOUND')
    const scopedList = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/subjects`,
      headers: investigatorHeaders,
    })
    expect(scopedList.statusCode).toBe(200)
    expect(scopedList.json().items).toHaveLength(1)
    expect(scopedList.json().items[0].site_name).toBe(siteName)
    const deniedGlobalUsers = await app!.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: investigatorHeaders,
    })
    expect(deniedGlobalUsers.statusCode).toBe(403)
    expect(deniedGlobalUsers.json().code).toBe('SYSTEM_ADMIN_REQUIRED')
    const explicitlyDeniedEvent = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/events`,
      headers: investigatorHeaders,
      payload: {
        eventType: 'note',
        occurredOn: '2026-07-17',
        title: '显式拒绝优先级测试',
      },
    })
    expect(explicitlyDeniedEvent.statusCode).toBe(403)
    expect(explicitlyDeniedEvent.json().code).toBe('PERMISSION_DENIED')

    const scopedDashboard = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/dashboard`,
      headers: investigatorHeaders,
    })
    expect(scopedDashboard.statusCode).toBe(200)
    expect(scopedDashboard.json()).toMatchObject({
      metrics: { screened: 1, enrolled: 1, randomized: 1 },
      randomization: {
        arms: [
          { id: 'A', label: '治疗组 A' },
          { id: 'B', label: '治疗组 B' },
        ],
        overall: { total: 1 },
        sites: [{ name: siteName, total: 1 }],
      },
    })
    expect(scopedDashboard.json().sites).toEqual([
      expect.objectContaining({ name: siteName, enrolled: 1 }),
    ])
    const selectedSiteDashboard = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/dashboard?siteId=${secondSiteId}`,
      headers,
    })
    expect(selectedSiteDashboard.statusCode).toBe(200)
    expect(selectedSiteDashboard.json().sites).toEqual([
      expect.objectContaining({ name: secondSiteName }),
    ])
    const deniedSelectedSiteDashboard = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/dashboard?siteId=${secondSiteId}`,
      headers: investigatorHeaders,
    })
    expect(deniedSelectedSiteDashboard.statusCode).toBe(403)
    expect(deniedSelectedSiteDashboard.json().code).toBe('SITE_ACCESS_DENIED')
    const crossSiteWrite = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects`,
      headers: investigatorHeaders,
      payload: { siteId: secondSiteId, screeningData: { diagnosis: '越权病例' } },
    })
    expect(crossSiteWrite.statusCode).toBe(403)
    expect(crossSiteWrite.json().code).toBe('SITE_ACCESS_DENIED')
    const crossSiteEvents = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/subjects/${secondSubjectId}/events`,
      headers: investigatorHeaders,
    })
    expect(crossSiteEvents.statusCode).toBe(403)
    expect(crossSiteEvents.json().code).toBe('SITE_ACCESS_DENIED')
    const deniedExport = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/exports`,
      headers: investigatorHeaders,
      payload: { dataset: 'subjects', format: 'csv', siteId },
    })
    expect(deniedExport.statusCode).toBe(403)
    expect(deniedExport.json().code).toBe('PERMISSION_DENIED')
    const siteAdminUserId = await createPlatformUser(
      headers,
      'site-administrator',
      '中心管理员',
      'Site-Administrator-Password-2026!',
    )
    const siteAdminMember = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/members`,
      headers,
      payload: {
        userId: siteAdminUserId,
        roleCode: 'site_admin',
        siteId,
        overrides: [],
      },
    })
    expect(siteAdminMember.statusCode).toBe(201)
    const siteAdminLogin = await app!.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        username: 'site-administrator',
        password: 'Site-Administrator-Password-2026!',
      },
    })
    const siteAdminHeaders = {
      cookie: String(siteAdminLogin.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': siteAdminLogin.json().csrfToken as string,
    }
    const siteAdminSchemeWrite = await app!.inject({
      method: 'PUT',
      url: `/api/v1/studies/${studyId}/randomization/scheme`,
      headers: siteAdminHeaders,
      payload: {},
    })
    expect(siteAdminSchemeWrite.statusCode).toBe(403)
    expect(siteAdminSchemeWrite.json().code).toBe('PERMISSION_DENIED')
    const siteAdminSites = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/sites`,
      headers: siteAdminHeaders,
    })
    expect(siteAdminSites.statusCode).toBe(200)
    expect(siteAdminSites.json().items).toEqual([expect.objectContaining({ name: siteName })])
    const observerCandidateId = await createPlatformUser(
      headers,
      'observer-candidate',
      '待分配观察者',
      'Observer-Candidate-Password-2026!',
      { gender: 'female', organization: '本中心医院' },
    )
    const forbiddenAdminCandidateId = await createPlatformUser(
      headers,
      'admin-candidate',
      '待分配管理员',
      'Admin-Candidate-Password-2026!',
    )
    const siteAdminCandidateSearch = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/members/candidates?name=${encodeURIComponent('待分配观察者')}`,
      headers: siteAdminHeaders,
    })
    expect(siteAdminCandidateSearch.statusCode).toBe(200)
    expect(siteAdminCandidateSearch.json().items).toEqual([
      expect.objectContaining({ id: observerCandidateId, organization: '本中心医院' }),
    ])
    const observerMembership = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/members`,
      headers: siteAdminHeaders,
      payload: {
        userId: observerCandidateId,
        roleCode: 'readonly',
        siteId,
        overrides: [],
      },
    })
    expect(observerMembership.statusCode).toBe(201)
    const siteAdminMemberList = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/members`,
      headers: siteAdminHeaders,
    })
    expect(siteAdminMemberList.statusCode).toBe(200)
    expect(siteAdminMemberList.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role_code: 'study_admin', manageable: false }),
        expect.objectContaining({
          user_id: siteAdminUserId,
          role_code: 'site_admin',
          manageable: false,
        }),
        expect.objectContaining({
          user_id: investigatorUserId,
          role_code: 'investigator',
          manageable: true,
        }),
        expect.objectContaining({
          user_id: observerCandidateId,
          role_code: 'readonly',
          manageable: true,
        }),
      ]),
    )
    const forbiddenAdminGrant = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/members`,
      headers: siteAdminHeaders,
      payload: {
        userId: forbiddenAdminCandidateId,
        roleCode: 'site_admin',
        siteId,
        overrides: [],
      },
    })
    expect(forbiddenAdminGrant.statusCode).toBe(403)
    expect(forbiddenAdminGrant.json().code).toBe('GRANT_SCOPE_EXCEEDED')
    const forbiddenSiteManage = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/sites`,
      headers: siteAdminHeaders,
      payload: { name: '中心管理员越权创建中心' },
    })
    expect(forbiddenSiteManage.statusCode).toBe(403)
    const forbiddenSiteExport = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/exports`,
      headers: siteAdminHeaders,
      payload: { dataset: 'subjects', format: 'csv', siteId },
    })
    expect(forbiddenSiteExport.statusCode).toBe(403)
    const makeReadonly = await app!.inject({
      method: 'PUT',
      url: `/api/v1/studies/${studyId}/members/${siteAdminMember.json().id}`,
      headers,
      payload: {
        roleCode: 'readonly',
        siteId,
        overrides: [],
        status: 'active',
      },
    })
    expect(makeReadonly.statusCode).toBe(200)
    const readonlyWrite = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/events`,
      headers: siteAdminHeaders,
      payload: {
        eventType: 'note',
        occurredOn: '2026-07-17',
        title: '只读账号写入测试',
      },
    })
    expect(readonlyWrite.statusCode).toBe(403)
    expect(readonlyWrite.json().code).toBe('PERMISSION_DENIED')
    const deleteSecondSubject = await app!.inject({
      method: 'DELETE',
      url: `/api/v1/studies/${studyId}/subjects/${secondSubjectId}`,
      headers,
      payload: { reason: '集成测试物理删除未随机化筛选对象' },
    })
    expect(deleteSecondSubject.statusCode).toBe(204)
    const deletedSubject = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/subjects/${secondSubjectId}`,
      headers,
    })
    expect(deletedSubject.statusCode).toBe(404)
    expect(
      existsSync(uploadPath)
        ? readdirSync(uploadPath, { recursive: true }).filter((path) =>
            /\.[a-z0-9]+$/i.test(String(path)),
          )
        : [],
    ).toHaveLength(0)

    const resetPassword = await app!.inject({
      method: 'POST',
      url: `/api/v1/users/${memberUserId}/reset-password`,
      headers,
      payload: { newPassword: 'Investigator-New-Password-2026' },
    })
    expect(resetPassword.statusCode).toBe(204)
    const revokedSession = await app!.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: investigatorHeaders,
    })
    expect(revokedSession.statusCode).toBe(401)
    const newPasswordLogin = await app!.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'site-investigator', password: 'Investigator-New-Password-2026' },
    })
    expect(newPasswordLogin.statusCode).toBe(200)
    const memberPasswordHeaders = {
      cookie: String(newPasswordLogin.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': newPasswordLogin.json().csrfToken as string,
    }
    const changeOwnPassword = await app!.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: memberPasswordHeaders,
      payload: {
        currentPassword: 'Investigator-New-Password-2026',
        newPassword: 'Investigator-Final-Password-2026',
      },
    })
    expect(changeOwnPassword.statusCode).toBe(204)
    expect(
      (
        await app!.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: {
            username: 'site-investigator',
            password: 'Investigator-New-Password-2026',
          },
        })
      ).statusCode,
    ).toBe(401)
    expect(
      (
        await app!.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: {
            username: 'site-investigator',
            password: 'Investigator-Final-Password-2026',
          },
        })
      ).statusCode,
    ).toBe(200)
    const disableGlobalUser = await app!.inject({
      method: 'PUT',
      url: `/api/v1/users/${memberUserId}/status`,
      headers,
      payload: { status: 'disabled' },
    })
    expect(disableGlobalUser.statusCode).toBe(200)
    const enableGlobalUser = await app!.inject({
      method: 'PUT',
      url: `/api/v1/users/${memberUserId}/status`,
      headers,
      payload: { status: 'active' },
    })
    expect(enableGlobalUser.statusCode).toBe(200)
  })

  it('完成表单草稿、发布、兼容升级、访视绑定与复制流程', async () => {
    const headers = { cookie: sessionCookie, 'x-csrf-token': csrfToken }
    const studyResponse = await app!.inject({
      method: 'POST',
      url: '/api/v1/studies',
      headers,
      payload: { protocolCode: 'FORM-TEST-001', name: '表单引擎集成测试' },
    })
    const studyId = studyResponse.json().id as string
    expect(
      (
        await app!.inject({
          method: 'POST',
          url: `/api/v1/studies/${studyId}/status`,
          headers,
          payload: { status: 'active' },
        })
      ).statusCode,
    ).toBe(200)
    const visitResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/visits`,
      headers,
      payload: { code: 'BASELINE', name: '基线', sortOrder: 1 },
    })
    expect(visitResponse.statusCode).toBe(201)
    const visitId = visitResponse.json().id as string
    const siteResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/sites`,
      headers,
      payload: { name: '表单测试中心', enrollmentTarget: 10 },
    })
    const siteId = siteResponse.json().id as string
    const subjectResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects`,
      headers,
      payload: { siteId, screeningData: {} },
    })
    const subjectId = subjectResponse.json().id as string
    const updateScreening = await app!.inject({
      method: 'PUT',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/screening`,
      headers,
      payload: {
        rowVersion: 1,
        screeningData: { diagnosis: '肝细胞癌', consent: true },
      },
    })
    expect(updateScreening.statusCode).toBe(200)
    expect(updateScreening.json().rowVersion).toBe(2)
    const staleScreeningUpdate = await app!.inject({
      method: 'PUT',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/screening`,
      headers,
      payload: { rowVersion: 1, screeningData: { diagnosis: '过期修改' } },
    })
    expect(staleScreeningUpdate.statusCode).toBe(409)
    expect(staleScreeningUpdate.json().code).toBe('ROW_VERSION_CONFLICT')
    const screeningDetail = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}`,
      headers,
    })
    expect(JSON.parse(screeningDetail.json().subject.screening_data_json)).toEqual({
      diagnosis: '肝细胞癌',
      consent: true,
    })
    const screeningTimeline = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/timeline`,
      headers,
    })
    expect(screeningTimeline.statusCode).toBe(200)
    expect(screeningTimeline.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'subject.screening_updated', object_id: subjectId }),
      ]),
    )
    expect(
      (
        await app!.inject({
          method: 'POST',
          url: `/api/v1/studies/${studyId}/subjects/${subjectId}/conclusion`,
          headers,
          payload: { conclusion: 'eligible' },
        })
      ).statusCode,
    ).toBe(200)
    const recordContext = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/records/context`,
      headers,
    })
    expect(recordContext.statusCode).toBe(200)
    expect(recordContext.json()).toEqual(
      expect.objectContaining({
        subject: expect.objectContaining({
          site_name: '表单测试中心',
        }),
        capabilities: expect.objectContaining({ enroll: true }),
      }),
    )
    const lockedScreeningUpdate = await app!.inject({
      method: 'PUT',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/screening`,
      headers,
      payload: { rowVersion: 3, screeningData: { diagnosis: '结论后修改' } },
    })
    expect(lockedScreeningUpdate.statusCode).toBe(409)
    expect(lockedScreeningUpdate.json().code).toBe('SCREENING_DATA_LOCKED')
    expect(
      (
        await app!.inject({
          method: 'POST',
          url: `/api/v1/studies/${studyId}/subjects/${subjectId}/enroll`,
          headers,
        })
      ).statusCode,
    ).toBe(200)

    const initialDefinition = {
      schemaVersion: 1,
      fields: [
        {
          key: 'age_years',
          type: 'number',
          label: '年龄',
          required: true,
          validation: { minimum: 18, maximum: 120 },
        },
        {
          key: 'treatment_group',
          type: 'radio',
          label: '治疗组别',
          options: [
            { value: 'a', label: 'A 组' },
            { value: 'b', label: 'B 组' },
          ],
          visibility: {
            logic: 'and',
            rules: [{ fieldKey: 'age_years', operator: 'gte', value: 18 }],
          },
        },
      ],
    }
    const createResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms`,
      headers,
      payload: {
        code: 'BASELINE_FORM',
        name: '基线资料',
        formType: 'baseline',
        repeatable: false,
        bindVisits: true,
        visitIds: [visitId],
        definition: initialDefinition,
      },
    })
    expect(createResponse.statusCode).toBe(201)
    const formId = createResponse.json().id as string

    const firstPublish = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms/${formId}/publish`,
      headers,
    })
    expect(firstPublish.statusCode).toBe(200)
    expect(firstPublish.json()).toMatchObject({
      versionNumber: 1,
      migratedRecords: 0,
      migrationStatus: 'pending',
    })
    await waitForMigration(studyId, formId, firstPublish.json().migrationJobId, headers)

    const incompatibleDraft = await app!.inject({
      method: 'PUT',
      url: `/api/v1/studies/${studyId}/forms/${formId}/draft`,
      headers,
      payload: {
        code: 'BASELINE_FORM',
        name: '基线资料',
        formType: 'baseline',
        repeatable: false,
        bindVisits: true,
        visitIds: [visitId],
        definition: {
          ...initialDefinition,
          fields: [{ key: 'age_years', type: 'date', label: '年龄' }],
        },
      },
    })
    expect(incompatibleDraft.statusCode).toBe(200)
    expect(incompatibleDraft.json().issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'INCOMPATIBLE_FIELD_TYPE' })]),
    )
    const blockedPublish = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms/${formId}/publish`,
      headers,
    })
    expect(blockedPublish.statusCode).toBe(400)
    expect(blockedPublish.json().code).toBe('FORM_PUBLISH_BLOCKED')

    const compatibleDefinition = {
      ...initialDefinition,
      fields: [
        ...initialDefinition.fields,
        {
          key: 'age_plus_one',
          type: 'calculated',
          label: '年龄加一',
          readOnly: true,
          calculation: {
            expression: 'age_years + 1',
            dependencies: ['age_years'],
            resultType: 'number',
            expressionVersion: 1,
          },
        },
      ],
    }
    const compatibleDraft = await app!.inject({
      method: 'PUT',
      url: `/api/v1/studies/${studyId}/forms/${formId}/draft`,
      headers,
      payload: {
        code: 'BASELINE_FORM',
        name: '基线资料 v2',
        formType: 'baseline',
        repeatable: false,
        bindVisits: true,
        visitIds: [visitId],
        definition: compatibleDefinition,
      },
    })
    expect(compatibleDraft.statusCode).toBe(200)
    expect(
      compatibleDraft
        .json()
        .issues.filter((issue: { severity: string }) => issue.severity === 'error'),
    ).toHaveLength(0)
    const secondPublish = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms/${formId}/publish`,
      headers,
    })
    expect(secondPublish.statusCode).toBe(200)
    expect(secondPublish.json().versionNumber).toBe(2)
    expect(secondPublish.json().migrationStatus).toBe('pending')
    await waitForMigration(studyId, formId, secondPublish.json().migrationJobId, headers)

    const formExcelExport = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms/${formId}/export/xlsx`,
      headers,
    })
    expect(formExcelExport.statusCode).toBe(200)
    expect(formExcelExport.headers['content-type']).toContain('spreadsheetml.sheet')
    const FormExcelJS = (await import('exceljs')).default
    const formWorkbook = new FormExcelJS.Workbook()
    await formWorkbook.xlsx.load(
      formExcelExport.rawPayload as unknown as Parameters<typeof formWorkbook.xlsx.load>[0],
    )
    expect(formWorkbook.worksheets.map((sheet) => sheet.name)).toEqual(['表单', '字段', '分区'])
    const metadataSheet = formWorkbook.getWorksheet('表单')!
    const fieldSheet = formWorkbook.getWorksheet('字段')!
    const metadataRows = new Map<string, number>()
    for (let row = 2; row <= metadataSheet.rowCount; row += 1)
      metadataRows.set(metadataSheet.getCell(row, 1).text, row)
    metadataSheet.getCell(metadataRows.get('code')!, 2).value = 'EXCEL_IMPORTED_FORM'
    metadataSheet.getCell(metadataRows.get('name')!, 2).value = 'Excel 导入表单'
    const headersByName = new Map<string, number>()
    fieldSheet.getRow(1).eachCell((cell, column) => headersByName.set(cell.text, column))
    const treatmentRow = fieldSheet
      .getColumn(headersByName.get('key')!)
      .values.findIndex((value) => value === 'treatment_group')
    const ageRow = fieldSheet
      .getColumn(headersByName.get('key')!)
      .values.findIndex((value) => value === 'age_years')
    expect(
      JSON.parse(fieldSheet.getCell(treatmentRow, headersByName.get('optionsJSON')!).text),
    ).toHaveLength(2)
    expect(
      JSON.parse(fieldSheet.getCell(ageRow, headersByName.get('validationJSON')!).text),
    ).toMatchObject({ minimum: 18, maximum: 120 })
    expect(
      JSON.parse(fieldSheet.getCell(treatmentRow, headersByName.get('visibilityJSON')!).text),
    ).toMatchObject({ rules: [{ fieldKey: 'age_years', operator: 'gte', value: 18 }] })
    const importedWorkbookBuffer = Buffer.from(await formWorkbook.xlsx.writeBuffer())
    const workbookBoundary = `----edc-form-workbook-${randomUUID()}`
    const workbookPayload = Buffer.concat([
      Buffer.from(
        `--${workbookBoundary}\r\nContent-Disposition: form-data; name="file"; filename="form.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`,
      ),
      importedWorkbookBuffer,
      Buffer.from(`\r\n--${workbookBoundary}--\r\n`),
    ])
    const excelPreview = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms/import/excel/preview`,
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${workbookBoundary}` },
      payload: workbookPayload,
    })
    expect(excelPreview.statusCode).toBe(200)
    expect(excelPreview.json()).toMatchObject({
      canImport: true,
      normalized: { code: 'EXCEL_IMPORTED_FORM', name: 'Excel 导入表单' },
      summary: { fieldCount: 3 },
    })
    const confirmExcelImport = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms`,
      headers: { ...headers, 'x-edc-import-format': 'xlsx' },
      payload: excelPreview.json().normalized,
    })
    expect(confirmExcelImport.statusCode).toBe(201)
    const corruptBoundary = `----edc-corrupt-workbook-${randomUUID()}`
    const corruptPayload = Buffer.from(
      `--${corruptBoundary}\r\nContent-Disposition: form-data; name="file"; filename="broken.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\nnot-a-workbook\r\n--${corruptBoundary}--\r\n`,
    )
    const corruptPreview = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms/import/excel/preview`,
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${corruptBoundary}` },
      payload: corruptPayload,
    })
    expect(corruptPreview.statusCode).toBe(400)
    expect(corruptPreview.json().code).toBe('FORM_EXCEL_INVALID')
    const formImportAudit = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/audit?action=form.imported`,
      headers,
    })
    expect(formImportAudit.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectId: confirmExcelImport.json().id,
          action: 'form.imported',
        }),
      ]),
    )

    const recordResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/records`,
      headers,
      payload: {
        formId,
        visitId,
        status: 'submitted',
        values: { age_years: 36, treatment_group: 'a' },
      },
    })
    expect(recordResponse.statusCode).toBe(201)
    const recordId = recordResponse.json().id as string
    const recordDetail = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/records/${recordId}`,
      headers,
    })
    expect(recordDetail.statusCode).toBe(200)
    expect(recordDetail.json().values).toMatchObject({
      age_years: 36,
      treatment_group: 'a',
      age_plus_one: 37,
    })
    const duplicateRecord = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/records`,
      headers,
      payload: { formId, visitId, status: 'draft', values: { age_years: 40 } },
    })
    expect(duplicateRecord.statusCode).toBe(409)

    const conflictUpdate = await app!.inject({
      method: 'PUT',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/records/${recordId}`,
      headers,
      payload: {
        rowVersion: 99,
        status: 'submitted',
        values: { age_years: 40, treatment_group: 'b' },
      },
    })
    expect(conflictUpdate.statusCode).toBe(409)
    expect(conflictUpdate.json().code).toBe('ROW_VERSION_CONFLICT')
    const updateRecord = await app!.inject({
      method: 'PUT',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/records/${recordId}`,
      headers,
      payload: {
        rowVersion: 1,
        status: 'submitted',
        values: { age_years: 40, treatment_group: 'b' },
      },
    })
    expect(updateRecord.statusCode).toBe(200)
    expect(updateRecord.json().rowVersion).toBe(2)

    const [{ sqlite }, { recoverFormMigrationJobs, waitForFormMigrationJobs }] = await Promise.all([
      import('../db/database.js'),
      import('../modules/forms/routes.js'),
    ])
    const activeVersion = sqlite
      .prepare(
        `SELECT v.id, v.schema_json, v.schema_checksum, v.created_by
         FROM forms f
         JOIN form_versions v ON v.id = f.active_version_id
         WHERE f.study_id = ? AND f.id = ?`,
      )
      .get(studyId, formId) as {
      id: string
      schema_json: string
      schema_checksum: string
      created_by: string
    }
    const recoveryVersionId = randomUUID()
    const recoveryJobId = randomUUID()
    const recoveryItemId = randomUUID()
    const recoveryNow = new Date().toISOString()
    sqlite.transaction(() => {
      sqlite
        .prepare(
          `INSERT INTO form_versions
           (id, form_id, version_number, status, schema_json, schema_checksum,
            created_by, created_at, updated_at)
           VALUES (?, ?, 3, 'migrating', ?, ?, ?, ?, ?)`,
        )
        .run(
          recoveryVersionId,
          formId,
          activeVersion.schema_json,
          activeVersion.schema_checksum,
          activeVersion.created_by,
          recoveryNow,
          recoveryNow,
        )
      sqlite
        .prepare(
          `INSERT INTO form_migration_jobs
           (id, study_id, form_id, from_version_id, to_version_id, status,
            total_records, processed_records, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'running', 1, 0, ?, ?, ?)`,
        )
        .run(
          recoveryJobId,
          studyId,
          formId,
          activeVersion.id,
          recoveryVersionId,
          activeVersion.created_by,
          recoveryNow,
          recoveryNow,
        )
      sqlite
        .prepare(
          `INSERT INTO form_migration_items
           (id, job_id, record_id, from_version_id, to_version_id, status, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          recoveryItemId,
          recoveryJobId,
          recordId,
          activeVersion.id,
          recoveryVersionId,
          recoveryNow,
        )
    })()

    recoverFormMigrationJobs()
    await waitForFormMigrationJobs()
    const migrationList = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/forms/${formId}/migrations`,
      headers,
    })
    expect(migrationList.statusCode).toBe(200)
    expect(migrationList.json()).toMatchObject({ canRetry: true })
    expect(migrationList.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: recoveryJobId,
          status: 'completed',
          from_version_number: 2,
          to_version_number: 3,
          processed_records: 1,
        }),
      ]),
    )
    expect(
      sqlite
        .prepare(
          `SELECT r.form_version_id, r.row_version, f.active_version_id
           FROM data_records r
           JOIN forms f ON f.study_id = r.study_id AND f.id = r.form_id
           WHERE r.study_id = ? AND r.id = ?`,
        )
        .get(studyId, recordId),
    ).toMatchObject({
      form_version_id: recoveryVersionId,
      active_version_id: recoveryVersionId,
      row_version: 3,
    })
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS value FROM audit_events
           WHERE study_id = ? AND subject_id = ? AND object_id = ?
             AND action = 'form.record_migrated'`,
        )
        .get(studyId, subjectId, recordId),
    ).toMatchObject({ value: 1 })

    const recordFileBoundary = `----edc-record-file-${randomUUID()}`
    const recordFilePayload = Buffer.from(
      `--${recordFileBoundary}\r\nContent-Disposition: form-data; name="file"; filename="record-evidence.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 linked record evidence\r\n--${recordFileBoundary}--\r\n`,
    )
    const recordFileUpload = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/files/supporting_document?recordId=${recordId}`,
      headers: {
        ...headers,
        'content-type': `multipart/form-data; boundary=${recordFileBoundary}`,
      },
      payload: recordFilePayload,
    })
    expect(recordFileUpload.statusCode).toBe(201)

    const copyResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms/${formId}/copy`,
      headers,
      payload: { code: 'BASELINE_COPY', name: '基线资料副本' },
    })
    expect(copyResponse.statusCode).toBe(201)

    const repeatableFormResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms`,
      headers,
      payload: {
        code: 'ADVERSE_EVENT',
        name: '不良事件',
        formType: 'adverse_event',
        repeatable: true,
        bindVisits: false,
        visitIds: [],
        definition: {
          schemaVersion: 1,
          fields: [{ key: 'event_name', type: 'text', label: '事件名称', required: true }],
        },
      },
    })
    const repeatableFormId = repeatableFormResponse.json().id as string
    const repeatablePublish = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms/${repeatableFormId}/publish`,
      headers,
    })
    expect(repeatablePublish.statusCode).toBe(200)
    await waitForMigration(
      studyId,
      repeatableFormId,
      repeatablePublish.json().migrationJobId,
      headers,
    )
    const repeatedRecordIds: string[] = []
    for (const expectedIndex of [1, 2]) {
      const repeated = await app!.inject({
        method: 'POST',
        url: `/api/v1/studies/${studyId}/subjects/${subjectId}/records`,
        headers,
        payload: {
          formId: repeatableFormId,
          visitId: null,
          status: 'submitted',
          values: { event_name: `事件 ${expectedIndex}` },
        },
      })
      expect(repeated.statusCode).toBe(201)
      expect(repeated.json().repeatIndex).toBe(expectedIndex)
      repeatedRecordIds.push(repeated.json().id as string)
    }

    const subjectListWithCompletion = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/subjects`,
      headers,
    })
    expect(subjectListWithCompletion.statusCode).toBe(200)
    expect(
      subjectListWithCompletion.json().items.find((item: { id: string }) => item.id === subjectId)
        ?.completion,
    ).toMatchObject({ expectedCount: 2, submittedCount: 2, draftCount: 0 })
    const adverseEvent = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/events`,
      headers,
      payload: {
        eventType: 'adverse_event',
        occurredOn: '2026-07-16',
        title: '轻度腹痛',
        details: '无需特殊处理',
        recordId: repeatedRecordIds[0],
      },
    })
    expect(adverseEvent.statusCode).toBe(201)
    const mismatchedRecord = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/events`,
      headers,
      payload: {
        eventType: 'adverse_event',
        occurredOn: '2026-07-16',
        title: '错误用途关联',
        recordId,
      },
    })
    expect(mismatchedRecord.statusCode).toBe(409)
    expect(mismatchedRecord.json().code).toBe('EVENT_RECORD_TYPE_MISMATCH')
    const unsupportedRecord = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/events`,
      headers,
      payload: {
        eventType: 'note',
        occurredOn: '2026-07-16',
        title: '一般记录不能关联表单',
        recordId: repeatedRecordIds[1],
      },
    })
    expect(unsupportedRecord.statusCode).toBe(400)
    expect(unsupportedRecord.json().code).toBe('EVENT_RECORD_NOT_SUPPORTED')
    const completeSubject = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/events`,
      headers,
      payload: {
        eventType: 'completed',
        occurredOn: '2026-07-16',
        title: '完成研究',
      },
    })
    expect(completeSubject.statusCode).toBe(201)
    expect(completeSubject.json().status).toBe('completed')
    const duplicateTerminalStatus = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/events`,
      headers,
      payload: {
        eventType: 'withdrawn',
        occurredOn: '2026-07-16',
        title: '退出研究',
        details: '状态机冲突测试',
      },
    })
    expect(duplicateTerminalStatus.statusCode).toBe(409)
    const subjectEvents = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/events`,
      headers,
    })
    expect(subjectEvents.json().items).toHaveLength(2)
    expect(subjectEvents.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'adverse_event',
          record_id: repeatedRecordIds[0],
          linked_form_name: '不良事件',
          linked_version_number: 1,
          linked_repeat_index: 1,
        }),
      ]),
    )

    const subjectExport = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/exports`,
      headers,
      payload: { dataset: 'subjects', format: 'csv', siteId },
    })
    expect(subjectExport.statusCode).toBe(201)
    expect(subjectExport.json()).toMatchObject({ status: 'queued', rowCount: null })
    const exportId = subjectExport.json().id as string
    expect(await waitForExport(studyId, exportId, headers)).toMatchObject({
      status: 'completed',
      rowCount: 1,
    })
    const exportList = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/exports`,
      headers,
    })
    expect(exportList.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: exportId, dataset: 'subjects', downloadable: true }),
      ]),
    )
    const exportDownload = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/exports/${exportId}/download`,
      headers,
    })
    expect(exportDownload.statusCode).toBe(200)
    expect(exportDownload.headers['content-type']).toContain('text/csv')
    expect(exportDownload.body).toContain('screening_number')

    const subjectExcelExport = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/exports`,
      headers,
      payload: { dataset: 'subjects', format: 'xlsx', siteId },
    })
    expect(subjectExcelExport.statusCode).toBe(201)
    expect(subjectExcelExport.json()).toMatchObject({ status: 'queued', rowCount: null })
    await waitForExport(studyId, subjectExcelExport.json().id, headers)
    const excelDownload = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/exports/${subjectExcelExport.json().id}/download`,
      headers,
    })
    expect(excelDownload.statusCode).toBe(200)
    expect(excelDownload.headers['content-type']).toContain('spreadsheetml.sheet')
    const ExcelJS = (await import('exceljs')).default
    const exportedWorkbook = new ExcelJS.Workbook()
    await exportedWorkbook.xlsx.load(
      excelDownload.rawPayload as unknown as Parameters<typeof exportedWorkbook.xlsx.load>[0],
    )
    const exportedWorksheet = exportedWorkbook.getWorksheet('数据')
    expect(exportedWorksheet?.getRow(1).values).toEqual(
      expect.arrayContaining(['screening_number', 'subject_number']),
    )
    expect(exportedWorksheet?.rowCount).toBeGreaterThan(1)

    const auditList = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/audit?action=export.completed`,
      headers,
    })
    expect(auditList.statusCode).toBe(200)
    expect(auditList.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'export.completed', objectType: 'export_job' }),
      ]),
    )
    const auditExport = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/exports`,
      headers,
      payload: { dataset: 'audit', format: 'csv', siteId },
    })
    expect(auditExport.statusCode).toBe(201)
    expect((await waitForExport(studyId, auditExport.json().id, headers)).rowCount).toBeGreaterThan(
      0,
    )

    const deleteRecord = await app!.inject({
      method: 'DELETE',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/records/${recordId}`,
      headers,
    })
    expect(deleteRecord.statusCode).toBe(204)
    const filesAfterRecordDelete = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/files`,
      headers,
    })
    expect(filesAfterRecordDelete.json().items).toHaveLength(0)
    expect(
      existsSync(uploadPath)
        ? readdirSync(uploadPath, { recursive: true }).filter((path) =>
            /\.[a-z0-9]+$/i.test(String(path)),
          )
        : [],
    ).toHaveLength(0)
    const formList = await app!.inject({
      method: 'GET',
      url: `/api/v1/studies/${studyId}/forms`,
      headers,
    })
    expect(formList.statusCode).toBe(200)
    expect(formList.json().items).toHaveLength(4)

    const importSource = {
      format: 'clinical-trial-edc-form',
      formatVersion: 1,
      form: {
        code: 'IMPORTED_BASELINE',
        name: '导入的基线表单',
        formType: 'baseline',
        repeatable: false,
        bindVisits: true,
        visitCodes: ['BASELINE'],
      },
      definition: initialDefinition,
    }
    const previewWithoutCsrf = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms/import/preview`,
      headers: { cookie: sessionCookie },
      payload: { source: importSource },
    })
    expect(previewWithoutCsrf.statusCode).toBe(403)

    const importPreview = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms/import/preview`,
      headers,
      payload: { source: importSource },
    })
    expect(importPreview.statusCode).toBe(200)
    expect(importPreview.json()).toMatchObject({
      canImport: true,
      normalized: { code: 'IMPORTED_BASELINE', visitIds: [visitId] },
      summary: { fieldCount: 2, visitCount: 1 },
    })
    const confirmImport = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms`,
      headers,
      payload: importPreview.json().normalized,
    })
    expect(confirmImport.statusCode).toBe(201)

    const duplicatePreview = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms/import/preview`,
      headers,
      payload: { source: importSource },
    })
    expect(duplicatePreview.statusCode).toBe(200)
    expect(duplicatePreview.json()).toMatchObject({ canImport: false })
    expect(duplicatePreview.json().issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'FORM_CODE_EXISTS' })]),
    )

    const missingVisitPreview = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms/import/preview`,
      headers,
      payload: {
        source: {
          ...importSource,
          form: { ...importSource.form, code: 'MISSING_VISIT', visitCodes: ['WEEK_999'] },
        },
      },
    })
    expect(missingVisitPreview.statusCode).toBe(200)
    expect(missingVisitPreview.json().issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'FORM_VISIT_CODE_MISSING' })]),
    )

    const lifecycleUserId = await createPlatformUser(
      headers,
      'lifecycle-member',
      '生命周期成员',
      'Lifecycle-Member-Password-2026!',
    )
    const lifecycleMember = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/members`,
      headers,
      payload: {
        userId: lifecycleUserId,
        roleCode: 'readonly',
        siteId,
        overrides: [],
      },
    })
    expect(lifecycleMember.statusCode).toBe(201)
    const lifecycleMembershipId = lifecycleMember.json().id as string

    const disableSite = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/sites/${siteId}/status`,
      headers,
      payload: { status: 'disabled' },
    })
    expect(disableSite.statusCode).toBe(200)
    const screeningAtDisabledSite = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects`,
      headers,
      payload: { siteId, screeningData: {} },
    })
    expect(screeningAtDisabledSite.statusCode).toBe(409)
    expect(screeningAtDisabledSite.json().code).toBe('SITE_DISABLED')
    const recordAtDisabledSite = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/records`,
      headers,
      payload: {},
    })
    expect(recordAtDisabledSite.statusCode).toBe(409)
    expect(recordAtDisabledSite.json().code).toBe('SITE_DISABLED')
    const eventAtDisabledSite = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects/${subjectId}/events`,
      headers,
      payload: {
        eventType: 'note',
        occurredOn: '2026-07-17',
        title: '停用中心写入测试',
      },
    })
    expect(eventAtDisabledSite.statusCode).toBe(409)
    expect(eventAtDisabledSite.json().code).toBe('SITE_DISABLED')
    expect(
      (
        await app!.inject({
          method: 'POST',
          url: `/api/v1/studies/${studyId}/sites/${siteId}/status`,
          headers,
          payload: { status: 'active' },
        })
      ).statusCode,
    ).toBe(200)

    const endStudy = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/status`,
      headers,
      payload: { status: 'ended', reason: '集成测试结束' },
    })
    expect(endStudy.statusCode).toBe(200)
    const writeAfterEnd = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/subjects`,
      headers,
      payload: { siteId, screeningData: {} },
    })
    expect(writeAfterEnd.statusCode).toBe(409)
    expect(writeAfterEnd.json().code).toBe('STUDY_READ_ONLY')
    for (const memberWrite of [
      {
        method: 'POST' as const,
        url: `/api/v1/studies/${studyId}/members`,
        payload: {
          userId: lifecycleUserId,
          roleCode: 'readonly',
          siteId,
          overrides: [],
        },
      },
      {
        method: 'PUT' as const,
        url: `/api/v1/studies/${studyId}/members/${lifecycleMembershipId}`,
        payload: {
          roleCode: 'readonly',
          siteId,
          overrides: [],
          status: 'active',
        },
      },
    ]) {
      const response = await app!.inject({ ...memberWrite, headers })
      expect(response.statusCode).toBe(409)
      expect(response.json().code).toBe('STUDY_READ_ONLY')
    }
    for (const endedWrite of [
      {
        method: 'POST' as const,
        url: `/api/v1/studies/${studyId}/sites`,
        payload: { name: '结束后中心' },
      },
      {
        method: 'POST' as const,
        url: `/api/v1/studies/${studyId}/forms/import/preview`,
        payload: { source: importSource },
      },
      {
        method: 'POST' as const,
        url: `/api/v1/studies/${studyId}/randomization/scheme/simulate`,
        payload: {},
      },
      {
        method: 'PUT' as const,
        url: `/api/v1/studies/${studyId}/counters`,
        payload: {
          screening: { prefix: 'SCR-', padLength: 4 },
          subject: { prefix: 'SUB-', padLength: 4 },
          randomization: { prefix: 'RND-', padLength: 4 },
        },
      },
      {
        method: 'POST' as const,
        url: `/api/v1/studies/${studyId}/subjects/${subjectId}/files/ended_file`,
        payload: '',
      },
    ]) {
      const response = await app!.inject({ ...endedWrite, headers })
      expect(response.statusCode).toBe(409)
      expect(response.json().code).toBe('STUDY_READ_ONLY')
    }
    const formExportAfterEnd = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms/${repeatableFormId}/export/json`,
      headers,
    })
    expect(formExportAfterEnd.statusCode).toBe(200)
    const exportAfterEnd = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/exports`,
      headers,
      payload: { dataset: 'subjects', format: 'csv' },
    })
    expect(exportAfterEnd.statusCode).toBe(201)
    const archiveStudy = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/status`,
      headers,
      payload: { status: 'archived' },
    })
    expect(archiveStudy.statusCode).toBe(200)
    const exportAfterArchive = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/exports`,
      headers,
      payload: { dataset: 'subjects', format: 'csv' },
    })
    expect(exportAfterArchive.statusCode).toBe(409)
    expect(exportAfterArchive.json().code).toBe('STUDY_READ_ONLY')
    const formExportAfterArchive = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms/${repeatableFormId}/export/json`,
      headers,
    })
    expect(formExportAfterArchive.statusCode).toBe(409)
    expect(formExportAfterArchive.json().code).toBe('STUDY_READ_ONLY')
    const defaultStudyList = await app!.inject({ method: 'GET', url: '/api/v1/studies', headers })
    expect(defaultStudyList.json().items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: studyId })]),
    )
  })

  it('千条数据的导出创建与表单迁移均在后台执行', async () => {
    const headers = { cookie: sessionCookie, 'x-csrf-token': csrfToken }
    const [{ sqlite }] = await Promise.all([import('../db/database.js')])
    const studyResponse = await app!.inject({
      method: 'POST',
      url: '/api/v1/studies',
      headers,
      payload: { protocolCode: `PERF-${randomUUID()}`, name: '后台任务性能验收' },
    })
    expect(studyResponse.statusCode).toBe(201)
    const studyId = studyResponse.json().id as string
    const siteResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/sites`,
      headers,
      payload: { name: '性能测试中心' },
    })
    expect(siteResponse.statusCode).toBe(201)
    const siteId = siteResponse.json().id as string
    const user = sqlite
      .prepare("SELECT id FROM users WHERE username = 'integration-admin'")
      .get() as { id: string }
    const now = new Date().toISOString()
    const subjectIds: string[] = []
    sqlite.transaction(() => {
      const insert = sqlite.prepare(
        `INSERT INTO subjects
         (id, study_id, site_id, screening_number, subject_number, status,
          screening_data_json, row_version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'enrolled', '{}', 1, ?, ?, ?)`,
      )
      for (let index = 1; index <= 1000; index += 1) {
        const id = randomUUID()
        subjectIds.push(id)
        const number = String(index).padStart(4, '0')
        insert.run(id, studyId, siteId, `PERF-S-${number}`, `PERF-P-${number}`, user.id, now, now)
      }
    })()

    const exportStartedAt = performance.now()
    const exportResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/exports`,
      headers,
      payload: { dataset: 'subjects', format: 'csv', siteId },
    })
    const exportAcceptedInMs = performance.now() - exportStartedAt
    expect(exportResponse.statusCode).toBe(201)
    expect(exportResponse.json()).toMatchObject({ status: 'queued', rowCount: null })
    expect(exportAcceptedInMs).toBeLessThan(1000)
    expect((await waitForExport(studyId, exportResponse.json().id, headers)).rowCount).toBe(1000)

    const definition = {
      schemaVersion: 1,
      sections: [],
      retiredFieldKeys: [],
      fields: [{ key: 'result', type: 'text', label: '结果' }],
    }
    const formResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms`,
      headers,
      payload: {
        code: 'PERF_FORM',
        name: '性能迁移表单',
        formType: 'custom',
        repeatable: false,
        bindVisits: false,
        visitIds: [],
        definition,
      },
    })
    expect(formResponse.statusCode).toBe(201)
    const formId = formResponse.json().id as string
    const initialPublish = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms/${formId}/publish`,
      headers,
    })
    await waitForMigration(studyId, formId, initialPublish.json().migrationJobId, headers)
    const activeVersion = sqlite
      .prepare(
        `SELECT f.active_version_id AS id FROM forms f
         WHERE f.study_id = ? AND f.id = ?`,
      )
      .get(studyId, formId) as { id: string }
    sqlite.transaction(() => {
      const insert = sqlite.prepare(
        `INSERT INTO data_records
         (id, study_id, site_id, subject_id, form_id, form_version_id, visit_id,
          repeat_index, status, row_version, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 1, 'submitted', 1, ?, ?, ?, ?)`,
      )
      for (const subjectId of subjectIds) {
        insert.run(
          randomUUID(),
          studyId,
          siteId,
          subjectId,
          formId,
          activeVersion.id,
          user.id,
          user.id,
          now,
          now,
        )
      }
    })()
    const draftResponse = await app!.inject({
      method: 'PUT',
      url: `/api/v1/studies/${studyId}/forms/${formId}/draft`,
      headers,
      payload: {
        code: 'PERF_FORM',
        name: '性能迁移表单 v2',
        formType: 'custom',
        repeatable: false,
        bindVisits: false,
        visitIds: [],
        definition: {
          ...definition,
          fields: [...definition.fields, { key: 'note', type: 'text', label: '备注' }],
        },
      },
    })
    expect(draftResponse.statusCode).toBe(200)
    const migrationStartedAt = performance.now()
    const migrationResponse = await app!.inject({
      method: 'POST',
      url: `/api/v1/studies/${studyId}/forms/${formId}/publish`,
      headers,
    })
    const migrationAcceptedInMs = performance.now() - migrationStartedAt
    expect(migrationResponse.statusCode).toBe(200)
    expect(migrationResponse.json().migrationStatus).toBe('pending')
    expect(migrationAcceptedInMs).toBeLessThan(1000)
    expect(
      await waitForMigration(studyId, formId, migrationResponse.json().migrationJobId, headers),
    ).toMatchObject({ status: 'completed', processed_records: 1000, total_records: 1000 })
  }, 60_000)

  it('所有已覆盖的成功业务写请求都生成审计日志', async () => {
    const { sqlite } = await import('../db/database.js')
    const explicitlyReadOnlyPosts = [
      /\/forms\/import\/preview$/,
      /\/forms\/import\/excel\/preview$/,
      /\/randomization\/scheme\/simulate$/,
    ]
    const idempotentWithoutWrite = [/\/randomization\/subjects\/[^/]+\/assign$/]
    const missing = successfulMutationRequests.filter((request) => {
      if (explicitlyReadOnlyPosts.some((pattern) => pattern.test(request.url))) return false
      const count = (
        sqlite
          .prepare('SELECT COUNT(*) AS value FROM audit_events WHERE request_id = ?')
          .get(request.id) as { value: number }
      ).value
      return count === 0 && !idempotentWithoutWrite.some((pattern) => pattern.test(request.url))
    })
    expect(missing).toEqual([])
  })
})
