<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from 'vue-i18n'
import type { FormDefinition } from '@edc/contracts'
import { validateFormRecord, type FormValue, type FormValueMap } from '@edc/domain/form-runtime'
import { apiRequest, ApiClientError } from '@/api/client'
import { useStudyStore } from '@/modules/studies/study.store'
import DynamicFormRenderer from '@/modules/forms/DynamicFormRenderer.vue'
import { formatRecordValidationIssue } from '@/modules/forms/form-validation-messages'
import StatusPill from '@/components/ui/StatusPill.vue'

interface SubjectRow {
  id: string
  site_id: string
  screening_number: string
  subject_number: string | null
  random_number: string | null
  status: string
  site_code: string
  site_name: string
  row_version: number
  screening_data_json: string
  screening_conclusion: string | null
  screening_failure_reason: string | null
}

interface FormContext {
  id: string
  code: string
  name: string
  formType: string
  repeatable: boolean
  bindVisits: boolean
  versionNumber: number
  definition: FormDefinition
  visitIds: string[]
}

interface VisitRow {
  id: string
  code: string
  name: string
}

interface RecordRow {
  id: string
  form_id: string
  form_name: string
  form_code: string
  form_type: string
  visit_id: string | null
  visit_name: string | null
  repeat_index: number
  status: 'draft' | 'submitted'
  row_version: number
  version_number: number
  updated_at: string
}

interface ServerIssue {
  fieldKey: string
  code: string
  message: string
  params?: Record<string, string | number>
  customMessage?: boolean
}

interface SubjectEventRow {
  id: string
  event_type: string
  occurred_on: string
  title: string
  details: string | null
  record_id: string | null
  linked_form_name: string | null
  linked_form_code: string | null
  linked_version_number: number | null
  linked_repeat_index: number | null
  before_status: string | null
  after_status: string | null
  created_by_name: string
  created_at: string
}

interface TimelineRow {
  id: string
  action: string
  object_type: string
  object_id: string | null
  reason: string | null
  actor_name: string | null
  created_at: string
}

interface SubjectFileRow {
  id: string
  fieldKey: string
  originalName: string
  mimeType: string
  sizeBytes: number
  createdAt: string
}

interface RandomizationContext {
  name: string
  method: string
  status: 'draft' | 'active' | 'frozen' | 'disabled'
  arms: Array<{ id: string; label: string }>
  factorKeys: string[]
}

interface RandomizationResult {
  randomNumber: string
  armId?: string
  assignment?: { arm_id: string; assigned_at: string }
  alreadyAssigned?: boolean
}

const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()
const studyStore = useStudyStore()
const loading = ref(false)
const saving = ref(false)
const subject = ref<SubjectRow | null>(null)
const forms = ref<FormContext[]>([])
const visits = ref<VisitRow[]>([])
const records = ref<RecordRow[]>([])
const events = ref<SubjectEventRow[]>([])
const timeline = ref<TimelineRow[]>([])
const subjectFiles = ref<SubjectFileRow[]>([])
const randomization = ref<RandomizationContext | null>(null)
const capabilities = ref({
  create: false,
  edit: false,
  delete: false,
  editScreening: false,
  enroll: false,
  randomize: false,
  manageEvents: false,
  deleteSubject: false,
})
const activeTab = ref('forms')
const eventDialogOpen = ref(false)
const eventSaving = ref(false)
const eventForm = ref({
  eventType: 'note',
  occurredOn: '',
  title: '',
  details: '',
  recordId: null as string | null,
})
const drawerOpen = ref(false)
const drawerReady = ref(false)
const drawerDirty = ref(false)
const selectedForm = ref<FormContext | null>(null)
const selectedVisitId = ref<string | null>(null)
const selectedRecord = ref<RecordRow | null>(null)
const values = ref<FormValueMap>({})
const rowVersion = ref(1)
const showErrors = ref(false)
const serverErrors = ref<Record<string, string[]>>({})
const screeningDrawerOpen = ref(false)
const screeningSaving = ref(false)
const screeningValues = ref<FormValueMap>({})
const screeningShowErrors = ref(false)
const conclusionDialogOpen = ref(false)
const conclusionSaving = ref(false)
const conclusionForm = ref<{ conclusion: 'eligible' | 'failed'; reason: string }>({
  conclusion: 'eligible',
  reason: '',
})
const randomizationDialogOpen = ref(false)
const randomizationSaving = ref(false)
const randomizationFactors = ref<Record<string, string>>({})

const subjectId = computed(() => String(route.params.id))
const statusLabels = computed<Record<string, string>>(() => ({
  screening: t('subjects.statuses.screening'),
  screen_failed: t('subjects.statuses.screenFailed'),
  pending_enrollment: t('subjects.statuses.pendingEnrollment'),
  enrolled: t('subjects.statuses.enrolled'),
  completed: t('subjects.statuses.completed'),
  withdrawn: t('subjects.statuses.withdrawn'),
  lost_to_followup: t('subjects.statuses.lostToFollowup'),
}))
const statusTones: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  screening: 'warning',
  screen_failed: 'danger',
  pending_enrollment: 'warning',
  enrolled: 'success',
  completed: 'success',
  withdrawn: 'neutral',
  lost_to_followup: 'danger',
}
const eventTypeLabels = computed<Record<string, string>>(() => ({
  adverse_event: t('subjects.detail.eventTypes.adverseEvent'),
  concomitant_medication: t('subjects.detail.eventTypes.concomitantMedication'),
  protocol_deviation: t('subjects.detail.eventTypes.protocolDeviation'),
  endpoint: t('subjects.detail.eventTypes.endpoint'),
  death: t('subjects.detail.eventTypes.death'),
  completed: t('subjects.detail.eventTypes.completed'),
  withdrawn: t('subjects.detail.eventTypes.withdrawn'),
  lost_to_followup: t('subjects.detail.eventTypes.lostToFollowup'),
  note: t('subjects.detail.eventTypes.note'),
}))
const statusEventTypes = new Set(['completed', 'withdrawn', 'lost_to_followup'])
const eventFormTypeMap: Record<string, string> = {
  adverse_event: 'adverse_event',
  concomitant_medication: 'concomitant_medication',
  protocol_deviation: 'protocol_deviation',
  endpoint: 'endpoint_event',
}
const eventRecordOptions = computed(() => {
  const formType = eventFormTypeMap[eventForm.value.eventType]
  return formType ? records.value.filter((record) => record.form_type === formType) : []
})
const screeningForm = computed(
  () => forms.value.find((form) => form.formType === 'screening') ?? null,
)
const clinicalForms = computed(() => forms.value.filter((form) => form.formType !== 'screening'))
const canExecuteRandomization = computed(
  () =>
    capabilities.value.randomize &&
    subject.value?.status === 'enrolled' &&
    !subject.value.random_number &&
    ['active', 'frozen'].includes(randomization.value?.status ?? ''),
)
const randomizationFactorLabels = computed<Record<string, string>>(() => ({
  site: t('randomization.factorLabels.site'),
  sex: t('randomization.factorLabels.sex'),
  age_group: t('randomization.factorLabels.ageGroup'),
  disease_stage: t('randomization.factorLabels.diseaseStage'),
}))
const timelineActionLabels = computed<Record<string, string>>(() => ({
  'subject.screening_created': t('subjects.detail.timelineActions.screeningCreated'),
  'subject.screening_concluded': t('subjects.detail.timelineActions.screeningConcluded'),
  'subject.screening_updated': t('subjects.detail.timelineActions.screeningUpdated'),
  'subject.enrolled': t('subjects.detail.timelineActions.enrolled'),
  'subject_event.created': t('subjects.detail.timelineActions.eventCreated'),
  'randomization.assigned': t('subjects.detail.timelineActions.randomized'),
  'data_record.created': t('subjects.detail.timelineActions.recordCreated'),
  'data_record.updated': t('subjects.detail.timelineActions.recordUpdated'),
  'data_record.deleted': t('subjects.detail.timelineActions.recordDeleted'),
  'file.uploaded': t('subjects.detail.timelineActions.fileUploaded'),
  'file.deleted': t('subjects.detail.timelineActions.fileDeleted'),
}))

function visitById(id: string) {
  return visits.value.find((visit) => visit.id === id)
}

function formRecords(formId: string, visitId: string | null = null) {
  return records.value.filter((record) => record.form_id === formId && record.visit_id === visitId)
}

function defaults(definition: FormDefinition) {
  return Object.fromEntries(
    definition.fields.flatMap((field) => {
      const value = field.defaultValue
      const valid =
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        (Array.isArray(value) && value.every((item) => typeof item === 'string'))
      return valid && value !== undefined ? [[field.key, structuredClone(value) as FormValue]] : []
    }),
  )
}

function parseScreeningValues() {
  try {
    return JSON.parse(subject.value?.screening_data_json ?? '{}') as FormValueMap
  } catch {
    return {}
  }
}

function screeningValueLabel(field: FormDefinition['fields'][number]) {
  const value = parseScreeningValues()[field.key]
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'boolean') return value ? t('subjects.detail.yes') : t('subjects.detail.no')
  const values = Array.isArray(value) ? value : [value]
  const optionLabels = new Map(field.options?.map((option) => [option.value, option.label]) ?? [])
  return values.map((item) => optionLabels.get(String(item)) ?? String(item)).join('、')
}

function openScreeningEdit() {
  screeningValues.value = structuredClone(parseScreeningValues())
  screeningShowErrors.value = false
  screeningDrawerOpen.value = true
}

async function saveScreening() {
  if (!studyStore.currentStudyId || !subject.value || !screeningForm.value) return
  screeningShowErrors.value = true
  if (validateFormRecord(screeningForm.value.definition, screeningValues.value).issues.length) {
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(
          '.screening-drawer .el-form-item.is-error input, .screening-drawer .el-form-item.is-error textarea',
        )
        ?.focus(),
    )
    return
  }
  screeningSaving.value = true
  try {
    await apiRequest(
      `/studies/${studyStore.currentStudyId}/subjects/${subjectId.value}/screening`,
      {
        method: 'PUT',
        body: JSON.stringify({
          rowVersion: subject.value.row_version,
          screeningData: screeningValues.value,
        }),
      },
    )
    screeningDrawerOpen.value = false
    ElMessage.success(t('subjects.detail.messages.screeningUpdated'))
    await load()
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError
        ? error.message
        : t('subjects.detail.messages.screeningSaveFailed'),
    )
    if (error instanceof ApiClientError && error.payload.code === 'ROW_VERSION_CONFLICT')
      await load()
  } finally {
    screeningSaving.value = false
  }
}

function openConclusionDialog() {
  conclusionForm.value = { conclusion: 'eligible', reason: '' }
  conclusionDialogOpen.value = true
}

async function submitConclusion() {
  if (!studyStore.currentStudyId || !subject.value) return
  if (conclusionForm.value.conclusion === 'failed' && !conclusionForm.value.reason.trim()) {
    ElMessage.warning(t('subjects.detail.messages.failureReasonRequired'))
    return
  }
  conclusionSaving.value = true
  try {
    await apiRequest(
      `/studies/${studyStore.currentStudyId}/subjects/${subjectId.value}/conclusion`,
      {
        method: 'POST',
        body: JSON.stringify(
          conclusionForm.value.conclusion === 'failed'
            ? { conclusion: 'failed', reason: conclusionForm.value.reason.trim() }
            : { conclusion: 'eligible' },
        ),
      },
    )
    conclusionDialogOpen.value = false
    ElMessage.success(
      conclusionForm.value.conclusion === 'eligible'
        ? t('subjects.detail.messages.eligibleSaved')
        : t('subjects.detail.messages.failedSaved'),
    )
    await load()
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError
        ? error.message
        : t('subjects.detail.messages.conclusionFailed'),
    )
  } finally {
    conclusionSaving.value = false
  }
}

async function enrollSubject() {
  if (!studyStore.currentStudyId || !subject.value) return
  const confirmed = await ElMessageBox.confirm(
    t('subjects.detail.messages.enrollPrompt'),
    t('subjects.detail.enroll'),
    {
      type: 'warning',
      confirmButtonText: t('subjects.detail.messages.confirmEnroll'),
      cancelButtonText: t('subjects.detail.cancel'),
    },
  ).catch(() => false)
  if (!confirmed) return
  try {
    const response = await apiRequest<{ subjectNumber: string }>(
      `/studies/${studyStore.currentStudyId}/subjects/${subjectId.value}/enroll`,
      { method: 'POST' },
    )
    ElMessage.success(t('subjects.detail.messages.enrolled', { number: response.subjectNumber }))
    await load()
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('subjects.detail.messages.enrollFailed'),
    )
  }
}

function screeningFactorValue(key: string) {
  if (key === 'site') return subject.value?.site_code ?? ''
  const value = parseScreeningValues()[key]
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? t('subjects.detail.yes') : t('subjects.detail.no')
  return ''
}

function openRandomizationDialog() {
  if (!randomization.value || !subject.value) return
  randomizationFactors.value = Object.fromEntries(
    randomization.value.factorKeys.map((key) => [key, screeningFactorValue(key)]),
  )
  randomizationDialogOpen.value = true
}

async function executeRandomization() {
  if (!studyStore.currentStudyId || !subject.value || !randomization.value) return
  const missingFactor = randomization.value.factorKeys.find(
    (key) => !randomizationFactors.value[key]?.trim(),
  )
  if (missingFactor) {
    ElMessage.warning(
      t('subjects.detail.messages.randomizationFactorRequired', {
        factor: randomizationFactorLabels.value[missingFactor] ?? missingFactor,
      }),
    )
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[data-randomization-factor="${missingFactor}"] input`)
        ?.focus(),
    )
    return
  }
  randomizationSaving.value = true
  try {
    const response = await apiRequest<RandomizationResult>(
      `/studies/${studyStore.currentStudyId}/randomization/subjects/${subjectId.value}/assign`,
      {
        method: 'POST',
        body: JSON.stringify({
          factors: Object.fromEntries(
            Object.entries(randomizationFactors.value).map(([key, value]) => [key, value.trim()]),
          ),
        }),
      },
    )
    const armId = response.armId ?? response.assignment?.arm_id
    const armLabel = randomization.value.arms.find((arm) => arm.id === armId)?.label ?? armId
    randomizationDialogOpen.value = false
    ElMessage.success(
      t('subjects.detail.messages.randomized', {
        number: response.randomNumber,
        arm: armLabel || t('subjects.detail.messages.armNotReturned'),
      }),
    )
    await load()
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError
        ? error.message
        : t('subjects.detail.messages.randomizationFailed'),
    )
  } finally {
    randomizationSaving.value = false
  }
}

async function load() {
  await studyStore.load()
  if (!studyStore.currentStudyId) return
  loading.value = true
  try {
    const [context, recordResponse, eventResponse, timelineResponse, fileResponse] =
      await Promise.all([
        apiRequest<{
          subject: SubjectRow
          forms: FormContext[]
          visits: VisitRow[]
          randomization: RandomizationContext | null
          capabilities: typeof capabilities.value
        }>(`/studies/${studyStore.currentStudyId}/subjects/${subjectId.value}/records/context`),
        apiRequest<{ items: RecordRow[] }>(
          `/studies/${studyStore.currentStudyId}/subjects/${subjectId.value}/records`,
        ),
        apiRequest<{ items: SubjectEventRow[] }>(
          `/studies/${studyStore.currentStudyId}/subjects/${subjectId.value}/events`,
        ),
        apiRequest<{ items: TimelineRow[] }>(
          `/studies/${studyStore.currentStudyId}/subjects/${subjectId.value}/timeline`,
        ),
        apiRequest<{ items: SubjectFileRow[] }>(
          `/studies/${studyStore.currentStudyId}/subjects/${subjectId.value}/files`,
        ),
      ])
    subject.value = context.subject
    forms.value = context.forms
    visits.value = context.visits
    randomization.value = context.randomization
    capabilities.value = context.capabilities
    records.value = recordResponse.items
    events.value = eventResponse.items
    timeline.value = timelineResponse.items
    subjectFiles.value = fileResponse.items
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('subjects.detail.messages.loadFailed'),
    )
  } finally {
    loading.value = false
  }
}

function openEventDialog(eventType = 'note') {
  const today = new Date()
  const localDate = new Date(today.getTime() - today.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10)
  eventForm.value = {
    eventType,
    occurredOn: localDate,
    title: eventTypeLabels.value[eventType] ?? '',
    details: '',
    recordId: null,
  }
  eventDialogOpen.value = true
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(new Date(value))
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

async function deleteSubject() {
  if (!studyStore.currentStudyId || !subject.value) return
  const result = await ElMessageBox.prompt(
    t('subjects.detail.messages.deletePrompt'),
    t('subjects.detail.deleteSubject'),
    {
      type: 'warning',
      inputPlaceholder: t('subjects.detail.messages.reasonPlaceholder'),
      inputValidator: (value) =>
        value.trim().length >= 3 || t('subjects.detail.messages.reasonMinLength'),
      confirmButtonText: t('subjects.detail.messages.confirmPhysicalDelete'),
      cancelButtonText: t('subjects.detail.cancel'),
    },
  ).catch(() => null)
  if (!result) return
  try {
    await apiRequest(`/studies/${studyStore.currentStudyId}/subjects/${subjectId.value}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason: result.value.trim() }),
    })
    ElMessage.success(t('subjects.detail.messages.subjectDeleted'))
    await router.push('/subjects')
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError
        ? error.message
        : t('subjects.detail.messages.subjectDeleteFailed'),
    )
  }
}

async function saveEvent() {
  if (!studyStore.currentStudyId || !eventForm.value.title.trim()) {
    ElMessage.warning(t('subjects.detail.messages.eventTitleRequired'))
    return
  }
  if (
    ['withdrawn', 'lost_to_followup'].includes(eventForm.value.eventType) &&
    !eventForm.value.details.trim()
  ) {
    ElMessage.warning(t('subjects.detail.messages.eventReasonRequired'))
    return
  }
  eventSaving.value = true
  try {
    await apiRequest(`/studies/${studyStore.currentStudyId}/subjects/${subjectId.value}/events`, {
      method: 'POST',
      body: JSON.stringify(eventForm.value),
    })
    eventDialogOpen.value = false
    activeTab.value = 'events'
    ElMessage.success(t('subjects.detail.messages.eventSaved'))
    await load()
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError
        ? error.message
        : t('subjects.detail.messages.eventSaveFailed'),
    )
  } finally {
    eventSaving.value = false
  }
}

function changeEventType(value: string) {
  eventForm.value.title = eventTypeLabels.value[value] ?? eventForm.value.title
  eventForm.value.recordId = null
}

function openLinkedRecord(event: SubjectEventRow) {
  if (!event.record_id) return
  const record = records.value.find((candidate) => candidate.id === event.record_id)
  if (record) void openEdit(record)
}

function openCreate(form: FormContext, visitId: string | null) {
  selectedForm.value = form
  selectedVisitId.value = visitId
  selectedRecord.value = null
  rowVersion.value = 1
  values.value = defaults(form.definition)
  showErrors.value = false
  serverErrors.value = {}
  drawerReady.value = false
  drawerOpen.value = true
  requestAnimationFrame(() => {
    drawerDirty.value = false
    drawerReady.value = true
  })
}

async function openEdit(record: RecordRow) {
  if (!studyStore.currentStudyId) return
  try {
    const detail = await apiRequest<{
      record: RecordRow
      definition: FormDefinition
      values: FormValueMap
    }>(`/studies/${studyStore.currentStudyId}/subjects/${subjectId.value}/records/${record.id}`)
    const form = forms.value.find((candidate) => candidate.id === record.form_id)
    selectedForm.value = form ? { ...form, definition: detail.definition } : null
    selectedVisitId.value = record.visit_id
    selectedRecord.value = record
    rowVersion.value = detail.record.row_version
    values.value = detail.values
    showErrors.value = false
    serverErrors.value = {}
    drawerReady.value = false
    drawerOpen.value = true
    requestAnimationFrame(() => {
      drawerDirty.value = false
      drawerReady.value = true
    })
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError
        ? error.message
        : t('subjects.detail.messages.recordLoadFailed'),
    )
  }
}

async function save(status: 'draft' | 'submitted') {
  if (!studyStore.currentStudyId || !selectedForm.value) return
  showErrors.value = status === 'submitted'
  serverErrors.value = {}
  if (status === 'submitted') {
    const result = validateFormRecord(selectedForm.value.definition, values.value)
    if (result.issues.length) {
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(
            '.record-drawer .el-form-item.is-error input, .record-drawer .el-form-item.is-error textarea',
          )
          ?.focus(),
      )
      return
    }
  }
  saving.value = true
  try {
    if (selectedRecord.value) {
      await apiRequest(
        `/studies/${studyStore.currentStudyId}/subjects/${subjectId.value}/records/${selectedRecord.value.id}`,
        {
          method: 'PUT',
          body: JSON.stringify({ rowVersion: rowVersion.value, values: values.value, status }),
        },
      )
    } else {
      await apiRequest(
        `/studies/${studyStore.currentStudyId}/subjects/${subjectId.value}/records`,
        {
          method: 'POST',
          body: JSON.stringify({
            formId: selectedForm.value.id,
            visitId: selectedVisitId.value,
            values: values.value,
            status,
          }),
        },
      )
    }
    drawerDirty.value = false
    drawerOpen.value = false
    ElMessage.success(
      status === 'submitted'
        ? t('subjects.detail.messages.dataSubmitted')
        : t('subjects.detail.messages.draftSaved'),
    )
    await load()
  } catch (error) {
    if (error instanceof ApiClientError) {
      const details = error.payload.details as { issues?: ServerIssue[] } | undefined
      for (const issue of details?.issues ?? []) {
        ;(serverErrors.value[issue.fieldKey] ??= []).push(
          formatRecordValidationIssue(issue, selectedForm.value.definition, t),
        )
      }
      if (error.payload.code === 'ROW_VERSION_CONFLICT') {
        ElMessageBox.alert(error.message, t('subjects.detail.messages.dataConflict'), {
          type: 'warning',
          confirmButtonText: t('subjects.detail.messages.reload'),
        }).then(() => (selectedRecord.value ? openEdit(selectedRecord.value) : undefined))
      } else ElMessage.error(error.message)
    } else {
      ElMessage.error(t('subjects.detail.messages.dataSaveFailed'))
    }
  } finally {
    saving.value = false
  }
}

async function deleteRecord(record: RecordRow) {
  if (!studyStore.currentStudyId) return
  const confirmed = await ElMessageBox.confirm(
    t('subjects.detail.messages.deleteRecordPrompt', {
      name: record.form_name,
      index: record.repeat_index,
    }),
    t('subjects.detail.messages.deleteRecordTitle'),
    {
      type: 'warning',
      confirmButtonText: t('subjects.detail.delete'),
      cancelButtonText: t('subjects.detail.cancel'),
    },
  ).then(
    () => true,
    () => false,
  )
  if (!confirmed) return
  try {
    await apiRequest(
      `/studies/${studyStore.currentStudyId}/subjects/${subjectId.value}/records/${record.id}`,
      { method: 'DELETE' },
    )
    ElMessage.success(t('subjects.detail.messages.recordDeleted'))
    await load()
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError
        ? error.message
        : t('subjects.detail.messages.recordDeleteFailed'),
    )
  }
}

function closeDrawer(done: () => void) {
  if (!drawerDirty.value) {
    done()
    return
  }
  ElMessageBox.confirm(
    t('subjects.detail.messages.unsavedPrompt'),
    t('subjects.detail.messages.unsavedTitle'),
    {
      type: 'warning',
      confirmButtonText: t('subjects.detail.messages.discard'),
      cancelButtonText: t('subjects.detail.messages.continueEditing'),
    },
  ).then(done, () => undefined)
}

watch(
  values,
  () => {
    if (drawerReady.value) drawerDirty.value = true
  },
  { deep: true },
)
watch(subjectId, load, { immediate: true })
</script>

<template>
  <div v-loading="loading">
    <section v-if="subject" class="subject-identity panel">
      <div>
        <span class="muted-text">{{ t('subjects.subjectNumber') }}</span
        ><strong>{{ subject.subject_number || t('subjects.detail.notEnrolled') }}</strong>
      </div>
      <div>
        <span class="muted-text">{{ t('subjects.screeningNumber') }}</span
        ><strong>{{ subject.screening_number }}</strong>
      </div>
      <div>
        <span class="muted-text">{{ t('subjects.randomNumber') }}</span
        ><strong>{{ subject.random_number || t('subjects.detail.notRandomized') }}</strong>
      </div>
      <div>
        <span class="muted-text">{{ t('subjects.site') }}</span
        ><strong>{{ subject.site_code }} · {{ subject.site_name }}</strong>
      </div>
      <StatusPill
        :tone="statusTones[subject.status] ?? 'neutral'"
        :label="statusLabels[subject.status] ?? subject.status"
      />
      <el-button
        v-if="canExecuteRandomization"
        class="subject-primary-action"
        type="primary"
        @click="openRandomizationDialog"
      >
        {{ t('subjects.detail.executeRandomization') }}
      </el-button>
      <el-button
        v-if="capabilities.deleteSubject && !subject.random_number"
        class="subject-delete"
        type="danger"
        plain
        @click="deleteSubject"
      >
        {{ t('subjects.detail.deleteSubject') }}
      </el-button>
    </section>

    <el-tabs v-if="subject" v-model="activeTab" class="subject-tabs">
      <el-tab-pane :label="t('subjects.detail.tabs.forms')" name="forms">
        <div class="form-record-grid">
          <article v-for="form in clinicalForms" :key="form.id" class="panel record-form-card">
            <header>
              <div>
                <span class="muted-text">{{ form.code }} · v{{ form.versionNumber }}</span>
                <h2>{{ form.name }}</h2>
              </div>
              <div class="record-tags">
                <el-tag v-if="form.repeatable" size="small" effect="plain">
                  {{ t('subjects.detail.repeatable') }}
                </el-tag>
                <el-tag v-if="form.bindVisits" size="small" effect="plain">
                  {{ t('subjects.detail.visitBased') }}
                </el-tag>
              </div>
            </header>

            <template v-if="form.bindVisits">
              <div v-for="visitId in form.visitIds" :key="visitId" class="visit-record-row">
                <div>
                  <strong>{{ visitById(visitId)?.name || visitId }}</strong>
                  <span class="muted-text">{{ visitById(visitId)?.code }}</span>
                </div>
                <div class="record-actions">
                  <template v-for="record in formRecords(form.id, visitId)" :key="record.id">
                    <StatusPill
                      :tone="record.status === 'submitted' ? 'success' : 'warning'"
                      :label="
                        record.status === 'submitted'
                          ? t('subjects.detail.submittedIndex', { index: record.repeat_index })
                          : t('subjects.detail.draftIndex', { index: record.repeat_index })
                      "
                    />
                    <el-button v-if="capabilities.edit" size="small" @click="openEdit(record)">
                      {{ t('subjects.detail.edit') }}
                    </el-button>
                    <el-button
                      v-if="capabilities.delete"
                      size="small"
                      type="danger"
                      plain
                      @click="deleteRecord(record)"
                    >
                      {{ t('subjects.detail.delete') }}
                    </el-button>
                  </template>
                  <el-button
                    v-if="
                      capabilities.create &&
                      (form.repeatable || !formRecords(form.id, visitId).length)
                    "
                    size="small"
                    type="primary"
                    plain
                    @click="openCreate(form, visitId)"
                  >
                    {{
                      form.repeatable ? t('subjects.detail.enterNew') : t('subjects.detail.enter')
                    }}
                  </el-button>
                </div>
              </div>
            </template>
            <div v-else class="visit-record-row">
              <div>
                <strong>{{ t('subjects.detail.nonVisitRecord') }}</strong
                ><span class="muted-text">{{
                  form.repeatable
                    ? t('subjects.detail.multipleAllowed')
                    : t('subjects.detail.singleOnly')
                }}</span>
              </div>
              <div class="record-actions">
                <template v-for="record in formRecords(form.id)" :key="record.id">
                  <StatusPill
                    :tone="record.status === 'submitted' ? 'success' : 'warning'"
                    :label="
                      record.status === 'submitted'
                        ? t('subjects.detail.submittedIndex', { index: record.repeat_index })
                        : t('subjects.detail.draftIndex', { index: record.repeat_index })
                    "
                  />
                  <el-button v-if="capabilities.edit" size="small" @click="openEdit(record)">
                    {{ t('subjects.detail.edit') }}
                  </el-button>
                  <el-button
                    v-if="capabilities.delete"
                    size="small"
                    type="danger"
                    plain
                    @click="deleteRecord(record)"
                  >
                    {{ t('subjects.detail.delete') }}
                  </el-button>
                </template>
                <el-button
                  v-if="capabilities.create && (form.repeatable || !formRecords(form.id).length)"
                  size="small"
                  type="primary"
                  plain
                  @click="openCreate(form, null)"
                >
                  {{ form.repeatable ? t('subjects.detail.enterNew') : t('subjects.detail.enter') }}
                </el-button>
              </div>
            </div>
          </article>
          <div v-if="!clinicalForms.length" class="panel empty-state">
            <div>
              <h2>{{ t('subjects.detail.noForms') }}</h2>
              <p class="muted-text">{{ t('subjects.detail.noFormsHint') }}</p>
            </div>
          </div>
        </div>
      </el-tab-pane>
      <el-tab-pane :label="t('subjects.detail.tabs.screening')" name="screening">
        <section class="panel screening-panel">
          <header class="screening-header">
            <div>
              <h2>{{ t('subjects.detail.screeningData') }}</h2>
              <p class="muted-text">
                {{
                  screeningForm
                    ? `${screeningForm.name} · v${screeningForm.versionNumber}`
                    : t('subjects.detail.noScreeningForm')
                }}
              </p>
            </div>
            <div class="screening-header-actions">
              <el-button
                v-if="capabilities.editScreening && subject.status === 'screening' && screeningForm"
                @click="openScreeningEdit"
              >
                {{ t('subjects.detail.editScreening') }}
              </el-button>
              <el-button
                v-if="capabilities.editScreening && subject.status === 'screening'"
                type="primary"
                @click="openConclusionDialog"
              >
                {{ t('subjects.detail.submitConclusion') }}
              </el-button>
              <el-button
                v-if="capabilities.enroll && subject.status === 'pending_enrollment'"
                type="primary"
                @click="enrollSubject"
              >
                {{ t('subjects.detail.enroll') }}
              </el-button>
            </div>
          </header>
          <dl v-if="screeningForm" class="screening-summary">
            <div v-for="field in screeningForm.definition.fields" :key="field.key">
              <dt>
                {{ field.label }}<span v-if="field.unit">（{{ field.unit }}）</span>
              </dt>
              <dd>{{ screeningValueLabel(field) }}</dd>
            </div>
          </dl>
          <el-empty v-else :description="t('subjects.detail.screeningEmpty')" />
          <el-alert
            v-if="subject.status !== 'screening'"
            :title="t('subjects.detail.screeningReadOnly')"
            type="info"
            show-icon
            :closable="false"
          />
        </section>
      </el-tab-pane>
      <el-tab-pane :label="t('subjects.detail.tabs.records')" name="records">
        <el-table :data="records" style="width: 100%">
          <el-table-column prop="form_name" :label="t('subjects.detail.form')" min-width="180" />
          <el-table-column prop="visit_name" :label="t('subjects.detail.visit')" min-width="140" />
          <el-table-column prop="repeat_index" :label="t('subjects.detail.sequence')" width="80" />
          <el-table-column :label="t('subjects.status')" width="110">
            <template #default="scope">
              <StatusPill
                :tone="scope.row.status === 'submitted' ? 'success' : 'warning'"
                :label="
                  scope.row.status === 'submitted'
                    ? t('subjects.detail.submitted')
                    : t('subjects.detail.draft')
                "
              />
            </template>
          </el-table-column>
          <el-table-column prop="updated_at" :label="t('subjects.updatedAt')" min-width="180" />
        </el-table>
      </el-tab-pane>
      <el-tab-pane :label="t('subjects.detail.tabs.events')" name="events">
        <section class="panel events-panel">
          <header class="events-header">
            <div>
              <h2>{{ t('subjects.detail.subjectEvents') }}</h2>
              <p class="muted-text">{{ t('subjects.detail.eventsHint') }}</p>
            </div>
            <el-button v-if="capabilities.manageEvents" type="primary" @click="openEventDialog()">
              {{ t('subjects.detail.addEvent') }}
            </el-button>
          </header>
          <div v-if="events.length" class="event-list">
            <article v-for="event in events" :key="event.id" class="event-item">
              <div class="event-date">{{ formatDate(event.occurred_on) }}</div>
              <div>
                <div class="event-title-row">
                  <strong>{{ event.title }}</strong>
                  <el-tag size="small" effect="plain">
                    {{ eventTypeLabels[event.event_type] ?? event.event_type }}
                  </el-tag>
                </div>
                <p v-if="event.details">{{ event.details }}</p>
                <el-button
                  v-if="event.record_id"
                  class="linked-record-button"
                  link
                  type="primary"
                  @click="openLinkedRecord(event)"
                >
                  {{
                    t('subjects.detail.linkedRecordLabel', {
                      name: event.linked_form_name,
                      version: event.linked_version_number,
                      index: event.linked_repeat_index,
                    })
                  }}
                </el-button>
                <span class="muted-text">
                  {{ event.created_by_name }} · {{ formatDateTime(event.created_at) }}
                  <template v-if="event.after_status">
                    ·
                    {{
                      t('subjects.detail.statusChangedTo', {
                        status: statusLabels[event.after_status] ?? event.after_status,
                      })
                    }}
                  </template>
                </span>
              </div>
            </article>
          </div>
          <div v-else class="empty-state">
            <div>
              <h2>{{ t('subjects.detail.noEvents') }}</h2>
              <p class="muted-text">{{ t('subjects.detail.noEventsHint') }}</p>
            </div>
          </div>
        </section>
      </el-tab-pane>
      <el-tab-pane :label="t('subjects.detail.tabs.files')" name="files">
        <section class="panel subject-files-panel">
          <el-table v-if="subjectFiles.length" :data="subjectFiles" style="width: 100%">
            <el-table-column
              prop="originalName"
              :label="t('subjects.detail.fileName')"
              min-width="220"
            />
            <el-table-column prop="fieldKey" :label="t('subjects.detail.field')" min-width="150" />
            <el-table-column :label="t('subjects.detail.size')" width="110">
              <template #default="scope">{{ formatBytes(scope.row.sizeBytes) }}</template>
            </el-table-column>
            <el-table-column
              prop="createdAt"
              :label="t('subjects.detail.uploadedAt')"
              min-width="180"
            />
            <el-table-column :label="t('subjects.actions')" width="100">
              <template #default="scope">
                <el-button
                  tag="a"
                  link
                  type="primary"
                  :href="`/api/v1/studies/${studyStore.currentStudyId}/subjects/${subjectId}/files/${scope.row.id}/download`"
                >
                  {{ t('subjects.detail.download') }}
                </el-button>
              </template>
            </el-table-column>
          </el-table>
          <div v-else class="empty-state">
            <div>
              <h2>{{ t('subjects.detail.noFiles') }}</h2>
              <p class="muted-text">{{ t('subjects.detail.noFilesHint') }}</p>
            </div>
          </div>
        </section>
      </el-tab-pane>
      <el-tab-pane :label="t('subjects.detail.tabs.timeline')" name="timeline">
        <section class="panel timeline-panel">
          <el-timeline v-if="timeline.length">
            <el-timeline-item
              v-for="item in timeline"
              :key="item.id"
              :timestamp="item.created_at"
              placement="top"
            >
              <strong>{{ timelineActionLabels[item.action] ?? item.action }}</strong>
              <p class="muted-text">
                {{ item.actor_name || t('subjects.detail.system') }} · {{ item.object_type }}
                <template v-if="item.reason">
                  · {{ t('subjects.detail.reason', { reason: item.reason }) }}
                </template>
              </p>
            </el-timeline-item>
          </el-timeline>
          <div v-else class="empty-state">
            <div>
              <h2>{{ t('subjects.detail.noTimeline') }}</h2>
              <p class="muted-text">{{ t('subjects.detail.noTimelineHint') }}</p>
            </div>
          </div>
        </section>
      </el-tab-pane>
    </el-tabs>
  </div>

  <el-drawer
    v-model="drawerOpen"
    class="record-drawer"
    :title="
      selectedForm
        ? t(selectedRecord ? 'subjects.detail.editForm' : 'subjects.detail.enterForm', {
            name: selectedForm.name,
          })
        : t('subjects.detail.dataEntry')
    "
    size="min(880px, 100vw)"
    :close-on-click-modal="false"
    :before-close="closeDrawer"
  >
    <el-alert
      v-if="selectedForm"
      :title="`${selectedForm.code} · v${selectedForm.versionNumber}${selectedVisitId ? ` · ${visitById(selectedVisitId)?.name}` : ''}`"
      type="info"
      :closable="false"
    />
    <DynamicFormRenderer
      v-if="selectedForm"
      v-model="values"
      :definition="selectedForm.definition"
      :show-errors="showErrors"
      :server-errors="serverErrors"
      :file-context="{
        studyId: studyStore.currentStudyId,
        subjectId,
        ...(selectedRecord ? { recordId: selectedRecord.id } : {}),
      }"
    />
    <template #footer>
      <el-button :loading="saving" @click="save('draft')">
        {{ t('subjects.detail.saveDraft') }}
      </el-button>
      <el-button type="primary" :loading="saving" @click="save('submitted')">
        {{ t('subjects.detail.submitData') }}
      </el-button>
    </template>
  </el-drawer>

  <el-drawer
    v-model="screeningDrawerOpen"
    class="screening-drawer"
    :title="t('subjects.detail.editScreening')"
    size="min(880px, 100vw)"
    :close-on-click-modal="false"
  >
    <el-alert
      v-if="screeningForm"
      :title="`${screeningForm.code} · v${screeningForm.versionNumber}`"
      type="info"
      :closable="false"
    />
    <DynamicFormRenderer
      v-if="screeningForm"
      v-model="screeningValues"
      :definition="screeningForm.definition"
      :show-errors="screeningShowErrors"
    />
    <template #footer>
      <el-button @click="screeningDrawerOpen = false">{{ t('subjects.detail.cancel') }}</el-button>
      <el-button type="primary" :loading="screeningSaving" @click="saveScreening">
        {{ t('subjects.detail.saveScreening') }}
      </el-button>
    </template>
  </el-drawer>

  <el-dialog
    v-model="randomizationDialogOpen"
    :title="t('subjects.detail.randomizationTitle')"
    width="min(560px, calc(100vw - 32px))"
    :close-on-click-modal="false"
  >
    <el-alert
      :title="t('subjects.detail.randomizationIrreversible')"
      type="warning"
      show-icon
      :closable="false"
    />
    <dl class="randomization-summary">
      <div>
        <dt>{{ t('subjects.subjectNumber') }}</dt>
        <dd>{{ subject?.subject_number }}</dd>
      </div>
      <div>
        <dt>{{ t('subjects.site') }}</dt>
        <dd>{{ subject?.site_code }} · {{ subject?.site_name }}</dd>
      </div>
      <div>
        <dt>{{ t('subjects.detail.randomizationScheme') }}</dt>
        <dd>{{ randomization?.name }}</dd>
      </div>
    </dl>
    <el-form v-if="randomization?.factorKeys.length" label-position="top" @submit.prevent>
      <el-form-item
        v-for="key in randomization.factorKeys"
        :key="key"
        :label="randomizationFactorLabels[key] ?? key"
        required
      >
        <el-input
          v-model="randomizationFactors[key]"
          :data-randomization-factor="key"
          :readonly="key === 'site'"
          maxlength="200"
        />
        <p v-if="key !== 'site'" class="form-help">
          {{ t('subjects.detail.randomizationFactorHelp') }}
        </p>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button :disabled="randomizationSaving" @click="randomizationDialogOpen = false">
        {{ t('subjects.detail.cancel') }}
      </el-button>
      <el-button type="primary" :loading="randomizationSaving" @click="executeRandomization">
        {{ t('subjects.detail.confirmRandomization') }}
      </el-button>
    </template>
  </el-dialog>

  <el-dialog
    v-model="conclusionDialogOpen"
    :title="t('subjects.detail.submitConclusion')"
    width="min(520px, calc(100vw - 32px))"
  >
    <el-form label-position="top" @submit.prevent>
      <el-form-item :label="t('subjects.detail.conclusion')" required>
        <el-radio-group v-model="conclusionForm.conclusion">
          <el-radio value="eligible">{{ t('subjects.detail.eligible') }}</el-radio>
          <el-radio value="failed">{{ t('subjects.detail.screenFailed') }}</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item
        v-if="conclusionForm.conclusion === 'failed'"
        :label="t('subjects.detail.failureReason')"
        required
      >
        <el-input v-model="conclusionForm.reason" type="textarea" :rows="4" maxlength="1000" />
      </el-form-item>
      <el-alert
        :title="t('subjects.detail.conclusionLocks')"
        type="warning"
        show-icon
        :closable="false"
      />
    </el-form>
    <template #footer>
      <el-button @click="conclusionDialogOpen = false">{{ t('subjects.detail.cancel') }}</el-button>
      <el-button type="primary" :loading="conclusionSaving" @click="submitConclusion">
        {{ t('subjects.detail.confirmSubmit') }}
      </el-button>
    </template>
  </el-dialog>

  <el-dialog
    v-model="eventDialogOpen"
    :title="t('subjects.detail.addSubjectEvent')"
    width="min(560px, calc(100vw - 32px))"
  >
    <el-form label-position="top" @submit.prevent>
      <el-form-item :label="t('subjects.detail.eventType')" required>
        <el-select
          v-model="eventForm.eventType"
          style="width: 100%"
          @change="changeEventType(String($event))"
        >
          <el-option
            v-for="(label, value) in eventTypeLabels"
            :key="value"
            :label="label"
            :value="value"
          />
        </el-select>
      </el-form-item>
      <el-form-item
        v-if="eventFormTypeMap[eventForm.eventType]"
        :label="t('subjects.detail.linkedRecord')"
      >
        <el-select
          v-model="eventForm.recordId"
          clearable
          :placeholder="t('subjects.detail.linkedRecordPlaceholder')"
          style="width: 100%"
        >
          <el-option
            v-for="record in eventRecordOptions"
            :key="record.id"
            :label="`${record.form_name} · v${record.version_number} · #${record.repeat_index}`"
            :value="record.id"
          />
        </el-select>
        <p class="form-help">
          {{
            eventRecordOptions.length
              ? t('subjects.detail.linkedRecordHelp')
              : t('subjects.detail.noMatchingRecord')
          }}
        </p>
      </el-form-item>
      <el-alert
        v-if="statusEventTypes.has(eventForm.eventType)"
        :title="t('subjects.detail.statusEventWarning')"
        type="warning"
        :closable="false"
      />
      <el-form-item :label="t('subjects.detail.occurredOn')" required>
        <el-date-picker
          v-model="eventForm.occurredOn"
          type="date"
          value-format="YYYY-MM-DD"
          style="width: 100%"
        />
      </el-form-item>
      <el-form-item :label="t('subjects.detail.eventTitle')" required>
        <el-input v-model="eventForm.title" maxlength="200" show-word-limit />
      </el-form-item>
      <el-form-item
        :label="
          ['withdrawn', 'lost_to_followup'].includes(eventForm.eventType)
            ? t('subjects.detail.reasonAndDetails')
            : t('subjects.detail.details')
        "
        :required="['withdrawn', 'lost_to_followup'].includes(eventForm.eventType)"
      >
        <el-input
          v-model="eventForm.details"
          type="textarea"
          :rows="4"
          maxlength="4000"
          show-word-limit
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="eventDialogOpen = false">{{ t('subjects.detail.cancel') }}</el-button>
      <el-button type="primary" :loading="eventSaving" @click="saveEvent">
        {{ t('subjects.detail.saveEvent') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.subject-identity {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px 32px;
  padding: 16px;
}
.subject-identity > div {
  display: grid;
  gap: 2px;
}
.subject-delete {
  margin-left: auto;
}
.subject-primary-action {
  margin-left: auto;
}
.subject-primary-action + .subject-delete {
  margin-left: 0;
}
.randomization-summary {
  display: grid;
  gap: 8px;
  margin: 16px 0;
}
.randomization-summary div {
  display: grid;
  grid-template-columns: minmax(120px, 0.35fr) minmax(0, 1fr);
  gap: 12px;
}
.randomization-summary dt {
  color: var(--color-text-secondary);
}
.randomization-summary dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.subject-files-panel,
.timeline-panel,
.screening-panel {
  padding: 16px;
}
.linked-record-button {
  min-height: 36px;
  padding-inline: 0;
}
.form-help {
  width: 100%;
  margin: 4px 0 0;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 1.5;
}
@media (max-width: 767px) {
  .linked-record-button {
    min-height: 44px;
  }
}
.screening-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.screening-header h2,
.screening-header p {
  margin: 0;
}
.screening-header-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.screening-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0;
  margin: 16px 0;
  border-top: 1px solid var(--color-border);
  border-left: 1px solid var(--color-border);
}
.screening-summary div {
  min-width: 0;
  padding: 12px;
  border-right: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
}
.screening-summary dt {
  color: var(--color-text-secondary);
  font-size: 13px;
}
.screening-summary dd {
  margin: 4px 0 0;
  overflow-wrap: anywhere;
}
.timeline-panel p {
  margin: 4px 0 0;
}
.subject-tabs {
  margin-top: 16px;
  padding: 0 16px 16px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
}
.form-record-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.record-form-card {
  padding: 16px;
}
.record-form-card header,
.visit-record-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.record-form-card h2 {
  margin: 3px 0 0;
  font-size: 17px;
}
.record-tags,
.record-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}
.visit-record-row {
  align-items: center;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
}
.visit-record-row > div:first-child {
  display: grid;
}
.record-drawer :deep(.el-alert) {
  margin-bottom: 16px;
}
.events-panel {
  padding: 16px;
}
.events-header,
.event-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.events-header h2,
.events-header p,
.event-item p {
  margin: 0;
}
.event-list {
  display: grid;
  gap: 0;
  margin-top: 16px;
}
.event-item {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 16px;
  padding: 14px 0;
  border-top: 1px solid var(--color-border);
}
.event-date {
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}
@media (max-width: 1100px) {
  .form-record-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 767px) {
  .subject-tabs {
    padding-right: 12px;
    padding-left: 12px;
  }
  .visit-record-row {
    align-items: flex-start;
    flex-direction: column;
  }
  .record-actions {
    justify-content: flex-start;
  }
  .events-header,
  .event-title-row {
    align-items: flex-start;
    flex-direction: column;
  }
  .event-item {
    grid-template-columns: 1fr;
    gap: 4px;
  }
  .screening-header {
    flex-direction: column;
  }
  .screening-header-actions {
    width: 100%;
    justify-content: flex-start;
  }
  .screening-header-actions .el-button {
    min-height: 44px;
    margin-left: 0;
  }
  .screening-summary {
    grid-template-columns: 1fr;
  }
}
</style>
