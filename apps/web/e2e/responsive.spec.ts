import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  const uploadedFileId = '11111111-1111-4111-8111-111111111111'
  let uploadedFile: Record<string, unknown> | null = null
  let subjectStatus = 'screening'
  let screeningRowVersion = 1
  let screeningData = { diagnosis: '肝细胞癌', consent: true }
  const subjectEvents: Array<Record<string, unknown>> = []
  const exportJobs: Array<Record<string, unknown>> = []
  let globalUserStatus = 'active'
  let userLocale = 'zh-CN'
  let userTheme = 'system'
  const studyCounters = {
    screening: { prefix: 'SCR-', padLength: 4, currentValue: 12 },
    subject: { prefix: 'SUB-', padLength: 4, currentValue: 8 },
    randomization: { prefix: 'RND-', padLength: 4, currentValue: 0 },
  }
  let savedFormDefinition: unknown = {
    schemaVersion: 1,
    fields: [],
    sections: [],
    retiredFieldKeys: [],
  }
  await page.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: 'test-user',
          username: 'admin',
          displayName: '测试管理员',
          isSystemAdmin: true,
          locale: userLocale,
          theme: userTheme,
        },
        csrfToken: 'test-csrf-token',
      }),
    })
  })

  await page.route('**/api/v1/auth/preferences', async (route) => {
    const payload = route.request().postDataJSON() as { locale: string; theme: string }
    userLocale = payload.locale
    userTheme = payload.theme
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: 'test-user',
          username: 'admin',
          displayName: '测试管理员',
          isSystemAdmin: true,
          locale: userLocale,
          theme: userTheme,
        },
      }),
    })
  })

  await page.route('**/api/v1/users?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        total: 1,
        page: 1,
        pageSize: 50,
        items: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            username: 'investigator',
            display_name: '研究医生',
            is_system_admin: 0,
            status: globalUserStatus,
            locale: 'zh-CN',
            theme: 'system',
            locked_until: null,
            study_count: 2,
            study_codes: 'E2E-STUDY,OTHER-STUDY',
            created_at: '2026-07-16T12:00:00.000Z',
            updated_at: '2026-07-16T12:00:00.000Z',
          },
        ],
      }),
    })
  })
  await page.route('**/api/v1/users/login-audit?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        total: 2,
        page: 1,
        pageSize: 100,
        items: [
          {
            id: 'login-1',
            request_id: 'request-1',
            action: 'auth.login_succeeded',
            attemptedUsername: 'admin',
            actor_name: '测试管理员',
            ip_address: '127.0.0.1',
            user_agent: 'Playwright',
            created_at: '2026-07-16T12:00:00.000Z',
          },
          {
            id: 'login-2',
            request_id: 'request-2',
            action: 'auth.login_failed',
            attemptedUsername: 'investigator',
            actor_name: '研究医生',
            ip_address: '127.0.0.1',
            user_agent: 'Playwright',
            created_at: '2026-07-16T11:00:00.000Z',
          },
        ],
      }),
    })
  })
  await page.route('**/api/v1/users/33333333-3333-4333-8333-333333333333/status', async (route) => {
    const payload = route.request().postDataJSON() as { status: string }
    globalUserStatus = payload.status
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: '33333333-3333-4333-8333-333333333333', status: payload.status }),
    })
  })

  await page.route('**/api/v1/studies', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'study-new' }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'study-1',
            protocol_code: 'E2E-STUDY',
            name: '响应式测试研究',
            sponsor: null,
            study_type: null,
            phase: null,
            status: 'draft',
            start_date: null,
            end_date: null,
            default_locale: 'zh-CN',
            notes: null,
            can_manage: true,
          },
          {
            id: 'study-2',
            protocol_code: 'E2E-STUDY-2',
            name: '第二响应式研究',
            sponsor: null,
            study_type: null,
            phase: null,
            status: 'ended',
            start_date: null,
            end_date: null,
            default_locale: 'zh-CN',
            notes: null,
            can_manage: true,
          },
        ],
      }),
    })
  })
  await page.route('**/api/v1/studies?includeArchived=true', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'study-1',
            protocol_code: 'E2E-STUDY',
            name: '响应式测试研究',
            sponsor: null,
            study_type: null,
            phase: null,
            status: 'draft',
            start_date: null,
            end_date: null,
            default_locale: 'zh-CN',
            notes: null,
            can_manage: true,
          },
          {
            id: 'study-2',
            protocol_code: 'E2E-STUDY-2',
            name: '第二响应式研究',
            sponsor: null,
            study_type: null,
            phase: null,
            status: 'ended',
            start_date: null,
            end_date: null,
            default_locale: 'zh-CN',
            notes: null,
            can_manage: true,
          },
        ],
      }),
    })
  })

  await page.route('**/api/v1/studies/study-1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'study-1' }),
    })
  })
  await page.route('**/api/v1/studies/study-1/counters', async (route) => {
    if (route.request().method() === 'PUT') {
      const payload = route.request().postDataJSON() as Record<
        keyof typeof studyCounters,
        { prefix: string; padLength: number }
      >
      for (const type of ['screening', 'subject', 'randomization'] as const)
        Object.assign(studyCounters[type], payload[type])
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ counters: studyCounters }),
    })
  })
  await page.route('**/api/v1/studies/study-2/counters', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ counters: studyCounters }),
    })
  })

  await page.route('**/api/v1/studies/study-1/dashboard', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        metrics: {
          screened: 12,
          enrolled: 8,
          randomized: 6,
          followupCompletionRate: 75,
          expectedFollowupRecords: 8,
          completedFollowupRecords: 6,
        },
        sites: [
          {
            id: 'site-1',
            code: 'SITE-01',
            name: '测试中心',
            enrollment_target: 20,
            enrolled: 8,
          },
        ],
        enrollmentTrend: [
          { period: '2026-06', value: 3 },
          { period: '2026-07', value: 5 },
        ],
        statusDistribution: [
          { status: 'screening', value: 4 },
          { status: 'enrolled', value: 8 },
        ],
        recentActivities: [
          {
            id: 'audit-1',
            action: 'subject.enrolled',
            object_type: 'subject',
            object_id: 'SUB-0214',
            site_id: 'site-1',
            created_at: '2026-07-16T12:00:00.000Z',
          },
        ],
      }),
    })
  })

  await page.route('**/api/v1/studies/study-1/randomization/scheme', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        route.request().method() === 'PUT'
          ? { id: 'scheme-1', status: 'draft' }
          : { scheme: null, canManage: true },
      ),
    })
  })
  await page.route('**/api/v1/studies/study-1/randomization/scheme/simulate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sampleSize: 200,
        method: 'stratified_block',
        results: [
          { armId: 'A', label: '治疗组 A', count: 100, percent: 50 },
          { armId: 'B', label: '治疗组 B', count: 100, percent: 50 },
        ],
      }),
    })
  })
  await page.route('**/api/v1/studies/study-1/randomization/scheme/activate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'scheme-1', status: 'active' }),
    })
  })

  await page.route('**/api/v1/studies/study-1/exports', async (route) => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as Record<string, unknown>
      exportJobs.unshift({
        id: '22222222-2222-4222-8222-222222222222',
        studyId: 'study-1',
        siteId: payload.siteId || null,
        dataset: payload.dataset,
        format: payload.format,
        status: 'completed',
        parameters: payload,
        rowCount: 12,
        errorMessage: null,
        requestedBy: '测试管理员',
        createdAt: '2026-07-16T12:00:00.000Z',
        completedAt: '2026-07-16T12:00:01.000Z',
        downloadable: true,
      })
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: exportJobs[0]!.id, status: 'completed', rowCount: 12 }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: exportJobs }),
    })
  })

  await page.route('**/api/v1/studies/study-1/audit?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        total: 1,
        page: 1,
        pageSize: 50,
        items: [
          {
            id: 'audit-1',
            requestId: 'request-1',
            actorUserId: 'test-user',
            actorUsername: 'admin',
            actorName: '测试管理员',
            siteId: 'site-1',
            siteCode: 'SITE-01',
            objectType: 'subject',
            objectId: 'SUB-0214',
            action: 'subject.enrolled',
            before: { status: 'pending_enrollment' },
            after: { status: 'enrolled', subjectNumber: 'SUB-0214' },
            reason: null,
            ipAddress: '127.0.0.1',
            userAgent: 'Playwright',
            createdAt: '2026-07-16T12:00:00.000Z',
          },
        ],
      }),
    })
  })

  await page.route('**/api/v1/studies/study-1/visits', async (route) => {
    await route.fulfill({
      status: route.request().method() === 'POST' ? 201 : 200,
      contentType: 'application/json',
      body: JSON.stringify(
        route.request().method() === 'POST'
          ? { id: 'visit-new' }
          : { items: [{ id: 'visit-1', code: 'BASELINE', name: '基线', sort_order: 0 }] },
      ),
    })
  })

  await page.route('**/api/v1/studies/study-1/sites', async (route) => {
    await route.fulfill({
      status: route.request().method() === 'POST' ? 201 : 200,
      contentType: 'application/json',
      body: JSON.stringify(
        route.request().method() === 'POST'
          ? { id: 'site-new' }
          : {
              items: [
                {
                  id: 'site-1',
                  code: 'SITE-01',
                  name: '测试中心',
                  principal_investigator: '张医生',
                  contact_name: '研究秘书',
                  contact_phone: '010-12345678',
                  contact_email: 'site01@example.test',
                  enrollment_target: 100,
                  enrolled_count: 36,
                  status: 'active',
                },
              ],
            },
      ),
    })
  })
  await page.route('**/api/v1/studies/study-2/sites', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [{ id: 'site-2', code: 'SITE-02', name: '第二测试中心', status: 'active' }],
      }),
    })
  })

  await page.route('**/api/v1/studies/study-1/subjects?*', async (route) => {
    const items = [
      ['subject-1', 'SCR-0280', 'SUB-0214', 'RND-0198', 'enrolled'],
      ['subject-2', 'SCR-0279', 'SUB-0213', null, 'enrolled'],
      ['subject-3', 'SCR-0286', null, null, 'screening'],
      ['subject-4', 'SCR-0277', 'SUB-0212', null, 'lost_to_followup'],
    ].map(([id, screening, subject, random, status], index) => ({
      id,
      screening_number: screening,
      subject_number: subject,
      random_number: random,
      status,
      site_id: 'site-1',
      site_code: 'SITE-01',
      site_name: '测试中心',
      updated_at: `2026-07-${16 - index}T09:42:00.000Z`,
    }))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items, total: items.length, page: 1, pageSize: 100 }),
    })
  })

  await page.route('**/api/v1/studies/study-1/forms', async (route) => {
    if (route.request().method() === 'POST') {
      savedFormDefinition = (route.request().postDataJSON() as { definition: unknown }).definition
    }
    await route.fulfill({
      status: route.request().method() === 'POST' ? 201 : 200,
      contentType: 'application/json',
      body: JSON.stringify(
        route.request().method() === 'POST'
          ? { id: 'form-new', draftVersionId: 'version-1', issues: [] }
          : { items: [] },
      ),
    })
  })

  await page.route('**/api/v1/studies/study-1/forms/form-new/draft', async (route) => {
    const payload = route.request().postDataJSON() as { definition: unknown }
    savedFormDefinition = payload.definition
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        draftVersionId: 'version-2',
        versionNumber: 1,
        definition: payload.definition,
        issues: [],
      }),
    })
  })

  await page.route('**/api/v1/studies/study-1/forms/form-new/publish', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        versionNumber: 1,
        migratedRecords: 0,
        migrationStatus: 'pending',
        warnings: [],
      }),
    })
  })

  await page.route('**/api/v1/studies/study-1/forms/form-new/migrations', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        canRetry: true,
        items: [
          {
            id: 'migration-1',
            from_version_id: 'version-1',
            to_version_id: 'version-2',
            from_version_number: 1,
            to_version_number: 2,
            status: 'completed',
            total_records: 24,
            processed_records: 24,
            error_message: null,
            created_at: '2026-07-16T09:30:00.000Z',
            updated_at: '2026-07-16T09:31:00.000Z',
            completed_at: '2026-07-16T09:31:00.000Z',
          },
        ],
      }),
    })
  })

  await page.route('**/api/v1/studies/study-1/forms/form-new', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        form: {
          id: 'form-new',
          code: 'E2E_FORM',
          name: 'E2E 动态表单',
          form_type: 'custom',
          repeatable: false,
          bindVisits: false,
          visitIds: [],
        },
        activeVersion: { version_number: 1, definition: savedFormDefinition },
        draftVersion: null,
        definition: savedFormDefinition,
      }),
    })
  })

  await page.route('**/api/v1/studies/study-1/forms/import/preview', async (route) => {
    const payload = route.request().postDataJSON() as {
      source: {
        form: {
          code: string
          name: string
          formType: string
          repeatable: boolean
          bindVisits: boolean
        }
        definition: unknown
      }
      overrides?: { code?: string; name?: string }
    }
    const normalized = {
      code: payload.overrides?.code ?? payload.source.form.code,
      name: payload.overrides?.name ?? payload.source.form.name,
      formType: payload.source.form.formType,
      repeatable: payload.source.form.repeatable,
      bindVisits: payload.source.form.bindVisits,
      visitIds: [],
      definition: payload.source.definition,
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        canImport: true,
        normalized,
        summary: { fieldCount: 1, sectionCount: 0, visitCount: 0 },
        issues: [],
      }),
    })
  })

  await page.route('**/api/v1/studies/study-1/forms/import/excel/preview', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        canImport: true,
        normalized: {
          code: 'EXCEL_FORM',
          name: 'Excel 导入表单',
          formType: 'custom',
          repeatable: false,
          bindVisits: false,
          visitIds: [],
          definition: {
            schemaVersion: 1,
            sections: [],
            retiredFieldKeys: [],
            fields: [
              {
                key: 'result',
                type: 'text',
                label: '结果',
                required: false,
                helpText: '',
                placeholder: '',
                unit: '',
                readOnly: false,
                hidden: false,
                exportable: true,
                options: [],
                validation: {},
              },
            ],
          },
        },
        summary: { fieldCount: 1, sectionCount: 0, visitCount: 0 },
        issues: [],
      }),
    })
  })

  await page.route('**/api/v1/studies/study-1/subjects/SUB-0214/records/context', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        subject: {
          id: 'SUB-0214',
          site_id: 'site-1',
          screening_number: 'SCR-0280',
          subject_number: 'SUB-0214',
          random_number: 'RND-0198',
          status: subjectStatus,
          row_version: screeningRowVersion,
          screening_data_json: JSON.stringify(screeningData),
          screening_conclusion: null,
          screening_failure_reason: null,
          site_code: 'SITE-01',
          site_name: '测试中心',
        },
        visits: [{ id: 'visit-1', code: 'BASELINE', name: '基线' }],
        capabilities: {
          create: true,
          edit: true,
          delete: false,
          editScreening: true,
          enroll: true,
          manageEvents: true,
          deleteSubject: true,
        },
        forms: [
          {
            id: 'screening-form',
            code: 'SCREENING',
            name: '受试者筛选表',
            formType: 'screening',
            repeatable: false,
            bindVisits: false,
            versionNumber: 1,
            visitIds: [],
            definition: {
              schemaVersion: 1,
              sections: [],
              retiredFieldKeys: [],
              fields: [
                {
                  key: 'diagnosis',
                  type: 'text',
                  label: '临床诊断',
                  required: true,
                  helpText: '',
                  placeholder: '',
                  unit: '',
                  readOnly: false,
                  hidden: false,
                  exportable: true,
                  options: [],
                  validation: {},
                },
                {
                  key: 'consent',
                  type: 'switch',
                  label: '已签署知情同意书',
                  required: true,
                  helpText: '',
                  placeholder: '',
                  unit: '',
                  readOnly: false,
                  hidden: false,
                  exportable: true,
                  options: [],
                  validation: {},
                },
              ],
            },
          },
          {
            id: 'form-runtime',
            code: 'BASELINE_FORM',
            name: '基线资料',
            formType: 'baseline',
            repeatable: false,
            bindVisits: true,
            versionNumber: 1,
            visitIds: ['visit-1'],
            definition: {
              schemaVersion: 1,
              sections: [],
              retiredFieldKeys: [],
              fields: [
                {
                  key: 'age_years',
                  type: 'number',
                  label: '年龄',
                  required: true,
                  helpText: '',
                  placeholder: '',
                  unit: '岁',
                  readOnly: false,
                  hidden: false,
                  exportable: true,
                  options: [],
                  validation: { minimum: 18, maximum: 80 },
                },
                {
                  key: 'has_symptoms',
                  type: 'switch',
                  label: '是否有症状',
                  required: false,
                  helpText: '',
                  placeholder: '',
                  unit: '',
                  readOnly: false,
                  hidden: false,
                  exportable: true,
                  options: [],
                  validation: {},
                },
                {
                  key: 'symptom_text',
                  type: 'text',
                  label: '症状描述',
                  required: true,
                  helpText: '',
                  placeholder: '请输入症状',
                  unit: '',
                  readOnly: false,
                  hidden: false,
                  exportable: true,
                  options: [],
                  validation: {},
                  visibility: {
                    logic: 'and',
                    rules: [{ fieldKey: 'has_symptoms', operator: 'eq', value: true }],
                  },
                },
                {
                  key: 'supporting_document',
                  type: 'file',
                  label: '支持性文件',
                  required: false,
                  helpText: '上传检查报告或其他研究资料',
                  placeholder: '',
                  unit: '',
                  readOnly: false,
                  hidden: false,
                  exportable: true,
                  options: [],
                  validation: {},
                },
              ],
            },
          },
        ],
      }),
    })
  })

  await page.route('**/api/v1/studies/study-1/subjects/SUB-0214/screening', async (route) => {
    const payload = route.request().postDataJSON() as {
      screeningData: typeof screeningData
    }
    screeningData = payload.screeningData
    screeningRowVersion += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'SUB-0214', rowVersion: screeningRowVersion }),
    })
  })

  await page.route('**/api/v1/studies/study-1/subjects/SUB-0214/records', async (route) => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as { values?: Record<string, unknown> }
      const fileIds = payload.values?.supporting_document
      if (!Array.isArray(fileIds) || fileIds[0] !== uploadedFileId) {
        await route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'FILE_REFERENCE_REQUIRED', message: '文件未关联到记录' }),
        })
        return
      }
    }
    await route.fulfill({
      status: route.request().method() === 'POST' ? 201 : 200,
      contentType: 'application/json',
      body: JSON.stringify(
        route.request().method() === 'POST'
          ? { id: 'record-1', repeatIndex: 1, rowVersion: 1, status: 'submitted' }
          : {
              items: [
                {
                  id: 'record-ae-1',
                  form_id: 'form-ae',
                  form_name: '不良事件表',
                  form_code: 'AE',
                  form_type: 'adverse_event',
                  visit_id: null,
                  visit_name: null,
                  repeat_index: 1,
                  status: 'submitted',
                  row_version: 1,
                  version_number: 2,
                  updated_at: '2026-07-16T12:00:00.000Z',
                },
              ],
            },
      ),
    })
  })

  await page.route(
    '**/api/v1/studies/study-1/subjects/SUB-0214/files/supporting_document*',
    async (route) => {
      uploadedFile = {
        id: uploadedFileId,
        recordId: null,
        fieldKey: 'supporting_document',
        originalName: '检查报告.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 24,
        sha256: 'a'.repeat(64),
        createdAt: '2026-07-16T12:00:00.000Z',
      }
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(uploadedFile),
      })
    },
  )

  await page.route('**/api/v1/studies/study-1/subjects/SUB-0214/files?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: uploadedFile ? [uploadedFile] : [] }),
    })
  })

  await page.route('**/api/v1/studies/study-1/subjects/SUB-0214/files', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: uploadedFile ? [uploadedFile] : [] }),
    })
  })

  await page.route('**/api/v1/studies/study-1/subjects/SUB-0214/timeline', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'timeline-1',
            action: 'subject.enrolled',
            object_type: 'subject',
            object_id: 'SUB-0214',
            reason: null,
            actor_name: '测试管理员',
            created_at: '2026-07-16T12:00:00.000Z',
          },
        ],
      }),
    })
  })

  await page.route(
    `**/api/v1/studies/study-1/subjects/SUB-0214/files/${uploadedFileId}`,
    async (route) => {
      uploadedFile = null
      await route.fulfill({ status: 204 })
    },
  )

  await page.route('**/api/v1/studies/study-1/subjects/SUB-0214/events', async (route) => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as Record<string, string>
      subjectStatus = payload.eventType === 'completed' ? 'completed' : subjectStatus
      subjectEvents.unshift({
        id: 'event-1',
        event_type: payload.eventType,
        occurred_on: payload.occurredOn,
        title: payload.title,
        details: payload.details || null,
        record_id: payload.recordId || null,
        linked_form_name: payload.recordId ? '不良事件表' : null,
        linked_form_code: payload.recordId ? 'AE' : null,
        linked_version_number: payload.recordId ? 2 : null,
        linked_repeat_index: payload.recordId ? 1 : null,
        before_status: payload.eventType === 'completed' ? 'enrolled' : null,
        after_status: payload.eventType === 'completed' ? 'completed' : null,
        created_by_name: '测试管理员',
        created_at: '2026-07-16T12:00:00.000Z',
      })
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'event-1', status: subjectStatus }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: subjectEvents }),
    })
  })

  await page.route('**/api/v1/studies/study-1/followups?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        total: 1,
        page: 1,
        pageSize: 100,
        visits: [{ id: 'visit-1', code: 'BASELINE', name: '基线' }],
        sites: [{ id: 'site-1', code: 'SITE-01', name: '测试中心' }],
        items: [
          {
            id: 'SUB-0214',
            site_id: 'site-1',
            screening_number: 'SCR-0280',
            subject_number: 'SUB-0214',
            random_number: 'RND-0198',
            status: 'enrolled',
            site_code: 'SITE-01',
            site_name: '测试中心',
            visits: [
              {
                id: 'visit-1',
                code: 'BASELINE',
                name: '基线',
                expectedCount: 1,
                submittedCount: 1,
                draftCount: 0,
                status: 'completed',
                updatedAt: '2026-07-16T12:00:00.000Z',
              },
            ],
          },
        ],
      }),
    })
  })
})

test('受试者页面在目标设备范围内无横向溢出', async ({ page }, testInfo) => {
  await page.goto('/subjects')
  await expect(page.getByRole('heading', { name: '受试者', level: 1 })).toBeVisible()
  const metrics = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width)

  if (testInfo.project.name === 'mobile') {
    await expect(page.locator('.mobile-nav')).toBeVisible()
    await expect(page.locator('.app-sidebar')).toHaveCount(0)
    await expect(page.locator('.subject-card')).toHaveCount(4)
    await expect(page.getByRole('button', { name: '导出', exact: true })).toHaveCount(0)
  } else {
    await expect(page.locator('.app-sidebar')).toBeVisible()
    await expect(page.locator('.mobile-nav')).toHaveCount(0)
  }

  if (testInfo.project.name === 'tablet' || testInfo.project.name === 'mobile') {
    const touchTargetSizes = await page
      .locator('.nav-item, .study-switcher, .icon-button, .user-button, .mobile-nav-item')
      .evaluateAll((elements) =>
        elements
          .filter((element) => {
            const rect = element.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0
          })
          .map((element) => {
            const rect = element.getBoundingClientRect()
            return { width: rect.width, height: rect.height }
          }),
      )
    expect(touchTargetSizes.length).toBeGreaterThan(0)
    expect(Math.min(...touchTargetSizes.map(({ width }) => width))).toBeGreaterThanOrEqual(44)
    expect(Math.min(...touchTargetSizes.map(({ height }) => height))).toBeGreaterThanOrEqual(44)
  }
})

test('全局中心作用域与受试者数据筛选保持联动', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机通过页面内中心筛选使用同一作用域')
  await page.goto('/subjects')
  const scopedRequest = page.waitForRequest(
    (request) => request.url().includes('/subjects?') && request.url().includes('siteId=site-1'),
  )
  await page.locator('.topbar .site-select').click()
  await page.getByRole('option', { name: 'SITE-01 · 测试中心' }).click()
  await scopedRequest
  await expect(page.getByText('当前中心：SITE-01 · 测试中心', { exact: true })).toBeVisible()
  await expect(page.locator('.subject-toolbar .el-select').nth(1)).toContainText(
    'SITE-01 · 测试中心',
  )
})

test('业务上下文页面切换研究前必须明确确认', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机顶部不直接提供研究切换控件')
  await page.goto('/subjects/SUB-0214')
  await page.locator('.topbar .study-select').click()
  await page.getByRole('option', { name: '第二响应式研究' }).click()
  const dialog = page.getByRole('dialog', { name: '切换研究项目' })
  await expect(dialog.getByText('切换研究将离开当前业务上下文')).toBeVisible()
  await dialog.getByRole('button', { name: '留在当前页面' }).click()
  await expect(page).toHaveURL('/subjects/SUB-0214')
  await expect(page.locator('.topbar .study-select')).toContainText('响应式测试研究')
})

test('设计系统指定断点与平板横竖屏均无横向溢出', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', '仅需由一个浏览器项目遍历全部断点')
  const viewports = [
    { width: 375, height: 812 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]
  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    await page.goto('/subjects')
    await expect(page.getByRole('heading', { name: '受试者', level: 1 })).toBeVisible()
    const metrics = await page.evaluate(() => ({
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }))
    expect(metrics.documentWidth, `${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(
      metrics.viewportWidth,
    )
  }
})

test('200% 浏览器缩放等效视口仍可完成核心查询', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', '由桌面浏览器验证 1920px 在 200% 缩放下的等效视口')
  await page.setViewportSize({ width: 960, height: 540 })
  await page.goto('/subjects')
  await expect(page.getByPlaceholder('搜索筛选号、受试者号或随机号')).toBeVisible()
  await expect(page.getByText('SCR-0280', { exact: true })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  expect(overflow).toBe(false)
})

test('关键页面交互控件具备可访问名称且标题层级连续', async ({ page }, testInfo) => {
  for (const path of ['/dashboard', '/subjects', '/subjects/SUB-0214', '/settings']) {
    await page.goto(path)
    if (testInfo.project.name !== 'mobile')
      await expect(page.getByRole('navigation', { name: '面包屑导航' })).toBeVisible()
    const violations = await page.evaluate(() => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }
      const unnamedButtons = [...document.querySelectorAll('button')]
        .filter(visible)
        .filter(
          (button) =>
            !button.textContent?.trim() &&
            !button.getAttribute('aria-label') &&
            !button.getAttribute('title'),
        ).length
      const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')]
        .filter(visible)
        .map((heading) => Number(heading.tagName.slice(1)))
      const skippedHeading = headings.some(
        (level, index) => index > 0 && level > (headings[index - 1] ?? level) + 1,
      )
      return { unnamedButtons, skippedHeading }
    })
    expect(violations, path).toEqual({ unnamedButtons: 0, skippedHeading: false })
  }
})

test('表单设计器桌面与平板保持可操作布局', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机端不开放复杂表单设计器')
  await page.goto('/forms/designer/new')
  await expect(page.getByRole('heading', { name: '表单设计', level: 1 })).toBeVisible()
  await expect(page.locator('.designer-column')).toHaveCount(3)
  await expect(page.locator('.field-chip')).toHaveCount(14)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  expect(overflow).toBe(false)
})

test('浅色与深色主题可以切换', async ({ page }) => {
  await page.goto('/dashboard')
  const before = await page.locator('html').getAttribute('data-theme')
  await page.getByRole('button', { name: '切换主题' }).click()
  const after = await page.locator('html').getAttribute('data-theme')
  expect(after).not.toBe(before)
})

test('减少动态效果偏好会关闭界面过渡动画', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', '由一个桌面浏览器验证媒体查询即可')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/subjects')
  const durations = await page.locator('.app-sidebar').evaluate((element) =>
    getComputedStyle(element)
      .transitionDuration.split(',')
      .map((value) => Number.parseFloat(value)),
  )
  expect(Math.max(...durations)).toBeLessThanOrEqual(0.01)
})

test('登录页可以在认证前切换语言和主题', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '由手机登录入口验证认证前偏好设置')
  await page.unroute('**/api/v1/auth/me')
  await page.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'AUTH_REQUIRED', message: '请先登录' }),
    })
  })
  await page.goto('/login')
  const beforeTheme = await page.locator('html').getAttribute('data-theme')
  await page.locator('.login-preferences .el-select').click()
  await page.getByRole('option', { name: 'English' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await page.getByRole('button', { name: 'Toggle sign-in theme' }).click()
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', beforeTheme ?? '')
})

test('设置页可持久化中英文与主题偏好', async ({ page }) => {
  await page.goto('/settings')
  await page.getByRole('radiogroup', { name: '系统语言' }).getByText('English').click()
  await expect(page.getByRole('heading', { name: 'Interface preferences' })).toBeVisible()
  await expect(page.getByText('Preferences saved')).toBeVisible()
  await page.getByText('Dark', { exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.goto('/subjects')
  await expect(
    page.getByPlaceholder('Search screening, subject, or randomization number'),
  ).toBeVisible()
  await expect(page.locator('#main-content').getByText('Enrolled', { exact: true })).toBeVisible()
  await page.goto('/subjects/SUB-0214')
  await expect(page.getByRole('tab', { name: 'Visits & Forms' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Screening Data' })).toBeVisible()
  await expect(page.getByText('Visit-based', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Enter Data', exact: true })).toBeVisible()
  await expect(page.getByText('基线资料', { exact: true })).toBeVisible()
})

test('项目仪表盘展示权限范围内的真实指标和表格替代', async ({ page }, testInfo) => {
  await page.goto('/dashboard')
  await expect(page.locator('.metric-grid').getByText('12', { exact: true })).toBeVisible()
  await expect(page.getByText('75%', { exact: true })).toBeVisible()
  await expect(page.getByRole('progressbar', { name: '测试中心入组进度' })).toHaveAttribute(
    'aria-valuenow',
    '40',
  )
  await expect(page.getByRole('img', { name: '月度入组趋势折线图' })).toBeVisible()
  await expect(
    page.locator('#main-content').getByText('SITE-01 · 测试中心', { exact: true }),
  ).toBeVisible()
  if (testInfo.project.name !== 'mobile') {
    await expect(page.getByText('SITE-01', { exact: true })).toBeVisible()
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  expect(overflow).toBe(false)
})

test('手机登录控件满足最小触控尺寸', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '仅验证手机触控尺寸')
  await page.unroute('**/api/v1/auth/me')
  await page.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'UNAUTHENTICATED' }),
    })
  })

  await page.goto('/login')
  await expect(page.getByRole('heading', { name: '登录系统', level: 2 })).toBeVisible()
  const controlHeights = await page
    .locator('.login-card .el-input__wrapper, .login-card .el-button')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))
  expect(controlHeights).toHaveLength(3)
  expect(Math.min(...controlHeights)).toBeGreaterThanOrEqual(44)
})

test('手机端不开放复杂配置页面', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '仅验证手机信息架构')
  await page.goto('/members')
  await expect(page).toHaveURL('/dashboard')
  await page.goto('/forms/designer/new')
  await expect(page).toHaveURL('/dashboard')
  await page.goto('/sites')
  await expect(page).toHaveURL('/dashboard')
  await page.goto('/randomization')
  await expect(page).toHaveURL('/dashboard')
  await page.goto('/exports')
  await expect(page).toHaveURL('/dashboard')
  await page.goto('/audit')
  await expect(page).toHaveURL('/dashboard')
  await page.goto('/users')
  await expect(page).toHaveURL('/dashboard')
  await page.goto('/study-settings')
  await expect(page).toHaveURL('/dashboard')
})

test('数据导出可手动生成持久化 CSV 任务', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机端不提供批量导出')
  await page.goto('/exports')
  await page.getByRole('button', { name: '生成导出文件' }).click()
  await expect(page.getByText('导出文件已生成')).toBeVisible()
  await expect(page.locator('.jobs-panel').getByText('受试者主数据', { exact: true })).toBeVisible()
  await expect(page.locator('.jobs-panel').getByText('12', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '下载' })).toBeVisible()
})

test('数据导出支持生成 Excel 工作簿任务', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机端不提供批量导出')
  await page.goto('/exports')
  await page.getByText('Excel (.xlsx)', { exact: true }).click()
  await page.getByRole('button', { name: '生成导出文件' }).click()
  await expect(page.getByText('导出文件已生成')).toBeVisible()
  await expect(page.locator('.jobs-panel').getByText('XLSX', { exact: true })).toBeVisible()
})

test('随机化方案可保存、模拟并启用', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机端不配置随机化方案')
  await page.goto('/randomization')
  await page.getByRole('button', { name: '运行模拟' }).click()
  await expect(page.getByText('100', { exact: true })).toHaveCount(2)
  await page.getByRole('button', { name: '验证并启用' }).click()
  const confirm = page.getByRole('dialog', { name: '启用随机化方案' })
  await confirm.getByRole('button', { name: '确认启用' }).click()
  await expect(page.locator('.el-message').getByText('随机化方案已启用')).toBeVisible()
  await expect(page.getByText('已启用', { exact: true })).toBeVisible()
})

test('审计日志支持筛选、差异详情与审计导出', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机端不提供审计管理')
  await page.goto('/audit')
  await expect(
    page.locator('.audit-results').getByText('受试者入组', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: '查看' }).click()
  const drawer = page.getByRole('dialog', { name: '审计变更详情' })
  await expect(drawer.getByText('pending_enrollment')).toBeVisible()
  await expect(drawer.getByRole('cell', { name: 'subject · SUB-0214', exact: true })).toBeVisible()
  await drawer.locator('.el-drawer__close-btn').click()
  await page.getByRole('button', { name: '导出审计 CSV' }).click()
  await expect(page.getByText('审计导出已生成，请到数据导出页面下载')).toBeVisible()
})

test('系统管理员可以通过界面创建研究项目', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机端不承担项目配置')
  await page.route('**/api/v1/studies/study-new/dashboard', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        metrics: {
          screened: 0,
          enrolled: 0,
          randomized: 0,
          followupCompletionRate: 0,
          expectedFollowupRecords: 0,
          completedFollowupRecords: 0,
        },
        sites: [],
        enrollmentTrend: [],
        statusDistribution: [],
        recentActivities: [],
      }),
    })
  })
  await page.goto('/studies')
  const toolbar = page.locator('.toolbar')
  await toolbar.getByRole('button', { name: '创建研究项目' }).click()
  const dialog = page.getByRole('dialog', { name: '创建研究项目' })
  await dialog.getByLabel('方案编号').fill('E2E-001')
  await dialog.getByLabel('研究名称').fill('响应式测试研究')
  await dialog.getByRole('button', { name: '创建项目' }).click()
  await expect(page).toHaveURL('/dashboard')
})

test('已结束研究在界面中保持只读并仅提供归档操作', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机端不承担项目配置')
  await page.goto('/studies')
  const card = page.locator('.study-card').filter({ hasText: '第二响应式研究' })
  await expect(card.getByText('已结束', { exact: true })).toBeVisible()
  await expect(card.getByRole('button', { name: '编辑' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: '归档' })).toBeVisible()
})

test('项目设置可保存未使用编号规则并冻结已分配规则', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机端不承担项目配置')
  await page.goto('/study-settings')
  await expect(page.getByRole('heading', { name: '编号规则', level: 2 })).toBeVisible()
  const screeningCard = page.locator('.counter-grid article').filter({ hasText: '筛选号' })
  await expect(screeningCard.getByLabel('编号前缀')).toBeDisabled()
  await expect(screeningCard.getByText('已分配 12 个编号，规则已冻结。')).toBeVisible()
  const randomizationCard = page.locator('.counter-grid article').filter({ hasText: '随机号' })
  await randomizationCard.getByLabel('编号前缀').fill('RAND-')
  await randomizationCard.getByLabel('补零位数').fill('6')
  await page.getByRole('button', { name: '保存项目设置' }).click()
  await expect(page.getByText('项目设置已保存')).toBeVisible()
  await expect(randomizationCard.getByText('下一个编号示例：RAND-000001')).toBeVisible()
})

test('系统超级管理员可以查看并停用全局账号', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机端不提供全局账号管理')
  await page.goto('/users')
  await expect(page.getByText('研究医生', { exact: true })).toBeVisible()
  await expect(page.getByText('E2E-STUDY,OTHER-STUDY', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '登录审计', exact: true }).click()
  const loginAudit = page.getByRole('dialog', { name: '登录审计' })
  await expect(loginAudit.getByText('admin', { exact: true })).toBeVisible()
  await expect(loginAudit.getByText('investigator', { exact: true })).toBeVisible()
  await loginAudit.locator('.el-drawer__close-btn').click()
  await page.getByRole('button', { name: '停用', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '停用账号' })
  await dialog.getByRole('button', { name: '确认', exact: true }).click()
  await expect(page.getByText('账号已停用')).toBeVisible()
  await expect(page.locator('.users-page').getByText('已停用', { exact: true })).toBeVisible()
})

test('中心管理支持中心概况和访视计划配置', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机端不开放中心与访视配置')
  await page.goto('/sites')
  await expect(page.getByRole('heading', { name: '中心管理', level: 1 })).toBeVisible()
  await expect(page.getByText('SITE-01', { exact: true })).toBeVisible()
  await expect(page.getByText('36 / 100', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '访视计划', exact: true }).click()
  await expect(page.getByText('BASELINE', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '新增访视', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新增访视' })
  await dialog.getByLabel('访视编号').fill('MONTH_3')
  await dialog.getByLabel('访视名称').fill('3 月随访')
  await dialog.getByRole('button', { name: '保存访视', exact: true }).click()
  await expect(page.getByText('访视已创建')).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  expect(overflow).toBe(false)
})

test('表单设计器可以添加字段、保存草稿并发布', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机端不开放表单设计器')
  await page.goto('/forms/designer/new')
  await page.getByRole('button', { name: '表单设置' }).click()
  const settings = page.getByRole('dialog', { name: '表单设置' })
  await settings.getByLabel('表单编号').fill('E2E_FORM')
  await settings.getByLabel('表单名称').fill('E2E 动态表单')
  await settings.getByRole('button', { name: '完成' }).click()
  await page.getByRole('button', { name: '数字' }).click()
  await page.getByRole('button', { name: '单选' }).click()
  await expect(page.locator('.canvas-field')).toHaveCount(2)
  if (testInfo.project.name === 'tablet') {
    const actionHeights = await page
      .locator('.field-actions .el-button')
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))
    expect(Math.min(...actionHeights)).toBeGreaterThanOrEqual(44)
  }
  await page.getByRole('button', { name: '保存草稿' }).click()
  await expect(page).toHaveURL('/forms/designer/form-new')
  await page.getByRole('button', { name: '发布 v1' }).click()
  await expect(page).toHaveURL('/forms')
  await expect(page.getByText('v1 迁移任务已创建，将在后台处理 0 条记录')).toBeVisible()
})

test('表单列表展示可追踪的版本迁移记录', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机端不开放表单配置与迁移管理')
  await page.route('**/api/v1/studies/study-1/forms', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'form-new',
            code: 'BASELINE',
            name: '基线资料',
            form_type: 'baseline',
            repeatable: 0,
            bind_visits: 1,
            status: 'published',
            active_version_number: 2,
            draft_version_number: null,
            draft_version_status: null,
            record_count: 24,
            updated_at: '2026-07-16T09:31:00.000Z',
          },
        ],
      }),
    })
  })
  await page.goto('/forms')
  await page.getByRole('button', { name: '迁移记录', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: '版本迁移 · 基线资料' })
  await expect(drawer.getByText('v1 → v2', { exact: true })).toBeVisible()
  await expect(drawer.getByText('已完成', { exact: true })).toBeVisible()
  await expect(drawer.getByText('已处理 24 / 24 条记录', { exact: true })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  expect(overflow).toBe(false)
})

test('表单 JSON 导入先预览校验再确认创建', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机端不开放表单配置')
  await page.goto('/forms')
  await page.getByRole('button', { name: '导入 JSON', exact: true }).click()
  await page.locator('input[accept=".json,application/json"]').setInputFiles({
    name: 'import-form.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'clinical-trial-edc-form',
        formatVersion: 1,
        form: {
          code: 'IMPORTED_FORM',
          name: '导入表单',
          formType: 'custom',
          repeatable: false,
          bindVisits: false,
        },
        definition: {
          schemaVersion: 1,
          sections: [],
          retiredFieldKeys: [],
          fields: [
            {
              key: 'result',
              type: 'text',
              label: '结果',
              required: false,
              helpText: '',
              placeholder: '',
              unit: '',
              readOnly: false,
              hidden: false,
              exportable: true,
              options: [],
              validation: {},
            },
          ],
        },
      }),
    ),
  })
  const dialog = page.getByRole('dialog', { name: '导入表单预览' })
  await expect(dialog.getByText('校验通过，可以导入')).toBeVisible()
  await expect(dialog.getByText('1', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(page).toHaveURL('/forms/designer/form-new')
})

test('表单 Excel 支持私有导出与预览后导入', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '手机端不开放表单配置')
  const excelDefinition = {
    schemaVersion: 1,
    sections: [],
    retiredFieldKeys: [],
    fields: [
      {
        key: 'result',
        type: 'text',
        label: '结果',
        required: false,
        options: [],
        validation: {},
      },
    ],
  }
  await page.route('**/api/v1/studies/study-1/forms', async (route) => {
    await route.fulfill({
      status: route.request().method() === 'POST' ? 201 : 200,
      contentType: 'application/json',
      body: JSON.stringify(
        route.request().method() === 'POST'
          ? { id: 'form-excel', draftVersionId: 'version-excel', issues: [] }
          : {
              items: [
                {
                  id: 'form-new',
                  code: 'BASELINE',
                  name: '基线资料',
                  form_type: 'baseline',
                  repeatable: 0,
                  bind_visits: 0,
                  status: 'published',
                  active_version_number: 1,
                  draft_version_number: null,
                  draft_version_status: null,
                  record_count: 12,
                  updated_at: '2026-07-16T09:30:00.000Z',
                },
              ],
            },
      ),
    })
  })
  await page.route('**/api/v1/studies/study-1/forms/form-new/export/xlsx', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      headers: { 'Content-Disposition': 'attachment; filename="BASELINE.xlsx"' },
      body: Buffer.from('mock-xlsx'),
    })
  })
  await page.route('**/api/v1/studies/study-1/forms/form-excel', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        form: {
          id: 'form-excel',
          code: 'EXCEL_FORM',
          name: 'Excel 导入表单',
          form_type: 'custom',
          repeatable: false,
          bindVisits: false,
          visitIds: [],
        },
        activeVersion: null,
        draftVersion: { version_number: 1, definition: excelDefinition },
        definition: excelDefinition,
      }),
    })
  })

  await page.goto('/forms')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 Excel', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toContain('BASELINE')

  await page.getByRole('button', { name: '导入 Excel', exact: true }).click()
  await page.locator('input[accept^=".xlsx"]').setInputFiles({
    name: 'form.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from('mock-xlsx'),
  })
  const dialog = page.getByRole('dialog', { name: '导入表单预览' })
  await expect(dialog.getByText('校验通过，可以导入')).toBeVisible()
  await expect(dialog.getByLabel('表单编号')).toHaveValue('EXCEL_FORM')
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(page).toHaveURL('/forms/designer/form-excel')
})

test('随访工作台按设备类别展示可录入对象', async ({ page }, testInfo) => {
  await page.goto('/followups')
  await expect(page.getByRole('heading', { name: '随访与数据录入', level: 1 })).toBeVisible()
  await expect(page.getByText('SUB-0214', { exact: true })).toBeVisible()
  if (testInfo.project.name === 'mobile') {
    const card = page.locator('.followup-card')
    await expect(card).toHaveCount(1)
    await expect(card.getByText('已完成', { exact: true })).toBeVisible()
    await expect(page.locator('.el-table')).toHaveCount(0)
  } else {
    const table = page.locator('.el-table')
    await expect(table).toBeVisible()
    await expect(table.getByText('已完成', { exact: true })).toBeVisible()
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  expect(overflow).toBe(false)
})

test('受试者动态表单支持条件字段和移动端数据提交', async ({ page }) => {
  await page.goto('/subjects/SUB-0214')
  await expect(page.getByText('SUB-0214', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '录入', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: '录入 · 基线资料' })
  await expect(drawer.getByLabel('症状描述')).toHaveCount(0)
  await drawer.getByLabel('年龄（岁）').fill('36')
  await drawer.locator('#form-field-has_symptoms .el-switch').click()
  await expect(drawer.getByLabel('症状描述')).toBeVisible()
  await drawer.getByLabel('症状描述').fill('腹痛')
  await drawer.getByLabel('选择支持性文件').setInputFiles({
    name: '检查报告.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 e2e supporting document'),
  })
  await expect(drawer.getByText('检查报告.pdf')).toBeVisible()
  await drawer.getByRole('button', { name: '提交数据' }).click()
  await expect(page.getByText('数据已提交')).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  expect(overflow).toBe(false)
})

test('动态表单提交失败显示可导航错误摘要并聚焦首个字段', async ({ page }) => {
  await page.goto('/subjects/SUB-0214')
  await page.getByRole('button', { name: '录入', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: '录入 · 基线资料' })
  await drawer.getByRole('button', { name: '提交数据' }).click()
  const summary = drawer.getByRole('alert')
  await expect(summary.getByText('请修正以下 1 个问题')).toBeVisible()
  await expect(summary.getByRole('link', { name: /年龄/ })).toBeVisible()
  await expect(drawer.getByLabel('年龄（岁）')).toBeFocused()
})

test('手机软键盘缩高后数据录入操作仍可见', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '仅验证手机软键盘视口缩高')
  await page.goto('/subjects/SUB-0214')
  await page.getByRole('button', { name: '录入', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: '录入 · 基线资料' })
  await drawer.getByLabel('年龄（岁）').focus()
  await page.setViewportSize({ width: 390, height: 500 })
  const submit = drawer.getByRole('button', { name: '提交数据' })
  await expect(submit).toBeVisible()
  const box = await submit.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y + box!.height).toBeLessThanOrEqual(500)
})

test('筛选资料支持动态表单编辑并刷新只读摘要', async ({ page }) => {
  await page.goto('/subjects/SUB-0214')
  await page.getByRole('tab', { name: '筛选资料', exact: true }).click()
  const panel = page.locator('.screening-panel')
  await expect(panel.getByText('肝细胞癌', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '编辑筛选资料', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: '编辑筛选资料' })
  await drawer.getByLabel('临床诊断').fill('肝内胆管癌')
  await drawer.getByRole('button', { name: '保存筛选资料', exact: true }).click()
  await expect(page.getByText('筛选资料已更新')).toBeVisible()
  await expect(panel.getByText('肝内胆管癌', { exact: true })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  expect(overflow).toBe(false)
})

test('新建筛选使用已发布动态表单并提交人工结论', async ({ page }) => {
  let created = false
  let savedDiagnosis = ''
  await page.route('**/api/v1/studies/study-1/forms', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'screening-form',
            code: 'SCREENING',
            name: '受试者筛选表',
            form_type: 'screening',
            status: 'published',
            active_version_number: 1,
          },
        ],
      }),
    })
  })
  await page.route('**/api/v1/studies/study-1/forms/screening-form', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        definition: {
          schemaVersion: 1,
          sections: [],
          retiredFieldKeys: [],
          fields: [
            {
              key: 'diagnosis',
              type: 'text',
              label: '临床诊断',
              required: true,
              options: [],
              validation: {},
            },
          ],
        },
      }),
    })
  })
  await page.route('**/api/v1/studies/study-1/subjects', async (route) => {
    created = true
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'subject-screen',
        screeningNumber: 'SCR-0301',
        status: 'screening',
      }),
    })
  })
  await page.route('**/api/v1/studies/study-1/subjects/subject-screen/screening', async (route) => {
    const payload = route.request().postDataJSON() as {
      screeningData: { diagnosis: string }
    }
    savedDiagnosis = payload.screeningData.diagnosis
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'subject-screen', rowVersion: 2 }),
    })
  })
  await page.route(
    '**/api/v1/studies/study-1/subjects/subject-screen/conclusion',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'subject-screen', status: 'pending_enrollment' }),
      })
    },
  )
  await page.route(
    '**/api/v1/studies/study-1/subjects/subject-screen/records/context',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          subject: {
            id: 'subject-screen',
            site_id: 'site-1',
            screening_number: 'SCR-0301',
            subject_number: null,
            random_number: null,
            status: 'pending_enrollment',
            row_version: 3,
            screening_data_json: JSON.stringify({ diagnosis: savedDiagnosis }),
            screening_conclusion: 'eligible',
            screening_failure_reason: null,
            site_code: 'SITE-01',
            site_name: '测试中心',
          },
          visits: [],
          forms: [],
          capabilities: {
            create: true,
            edit: true,
            delete: false,
            editScreening: true,
            enroll: true,
            manageEvents: true,
            deleteSubject: true,
          },
        }),
      })
    },
  )
  for (const resource of ['records', 'events', 'timeline', 'files']) {
    await page.route(
      `**/api/v1/studies/study-1/subjects/subject-screen/${resource}`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: [] }),
        })
      },
    )
  }

  await page.goto('/subjects/new-screening')
  await page.getByRole('button', { name: '建立筛选记录', exact: true }).click()
  await expect(
    page.locator('.screening-section-heading').getByText('SCR-0301', { exact: false }),
  ).toBeVisible()
  await page.getByLabel('临床诊断').fill('肝细胞癌')
  await page.getByRole('button', { name: '保存并下一步', exact: true }).click()
  await page.getByText('符合入组标准', { exact: true }).click()
  await page.getByRole('button', { name: '提交筛选结论', exact: true }).click()
  await expect(page).toHaveURL('/subjects/subject-screen')
  expect(created).toBe(true)
  expect(savedDiagnosis).toBe('肝细胞癌')
})

test('受试者事件可记录研究完成并同步展示状态', async ({ page }) => {
  await page.goto('/subjects/SUB-0214')
  await page.getByRole('tab', { name: '事件记录' }).click()
  await page.getByRole('button', { name: '新增事件' }).click()
  const dialog = page.getByRole('dialog', { name: '新增受试者事件' })
  await dialog.locator('.el-select').click()
  await page.getByRole('option', { name: '研究完成' }).click()
  await expect(dialog.getByText('保存后将同步变更受试者主状态')).toBeVisible()
  await dialog.getByRole('button', { name: '保存事件' }).click()
  await expect(page.getByText('事件已记录')).toBeVisible()
  await expect(page.getByText('研究完成', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('已完成', { exact: true }).first()).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  expect(overflow).toBe(false)
})

test('预设用途事件可关联匹配的数据记录', async ({ page }) => {
  await page.goto('/subjects/SUB-0214')
  await page.getByRole('tab', { name: '事件记录' }).click()
  await page.getByRole('button', { name: '新增事件' }).click()
  const dialog = page.getByRole('dialog', { name: '新增受试者事件' })
  await dialog.locator('.el-select').first().click()
  await page.getByRole('option', { name: '不良事件' }).click()
  await expect(dialog.getByText('关联数据记录（可选）')).toBeVisible()
  await dialog.locator('.el-select').nth(1).click()
  await page.getByRole('option', { name: '不良事件表 · v2 · #1' }).click()
  await dialog.getByRole('button', { name: '保存事件' }).click()
  await expect(page.getByText('不良事件表 · v2 · 记录 #1')).toBeVisible()
})

test('受试者详情时间线汇总关键业务动作', async ({ page }) => {
  await page.goto('/subjects/SUB-0214')
  await page.getByRole('tab', { name: '时间线' }).click()
  await expect(page.getByText('完成受试者入组', { exact: true })).toBeVisible()
  await expect(page.getByText('测试管理员 · subject', { exact: true })).toBeVisible()
})
