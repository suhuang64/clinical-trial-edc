<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Button as VanButton, Tag as VanTag } from 'vant'
import { ElMessage } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { apiRequest, ApiClientError } from '@/api/client'
import { useViewport } from '@/composables/useViewport'
import { useStudyStore } from '@/modules/studies/study.store'
import { useSiteScopeStore } from '@/modules/studies/site-scope.store'
import StatusPill from '@/components/ui/StatusPill.vue'

type VisitStatus = 'completed' | 'in_progress' | 'not_started'

interface VisitSummary {
  id: string
  code: string
  name: string
  expectedCount: number
  submittedCount: number
  draftCount: number
  status: VisitStatus
  updatedAt: string | null
}

interface FollowupSubject {
  id: string
  screening_number: string
  subject_number: string | null
  random_number: string | null
  status: string
  site_name: string
  visits: VisitSummary[]
}

interface WorklistResponse {
  items: FollowupSubject[]
  visits: Array<{ id: string; code: string; name: string }>
  sites: Array<{ name: string }>
  total: number
  page: number
  pageSize: number
}

const router = useRouter()
const { t } = useI18n()
const studyStore = useStudyStore()
const siteScope = useSiteScopeStore()
const { width } = useViewport()
const loading = ref(false)
const query = ref('')
const siteName = ref('')
const visitId = ref('')
const items = ref<FollowupSubject[]>([])
const visits = ref<WorklistResponse['visits']>([])
const sites = ref<WorklistResponse['sites']>([])
const total = ref(0)
const isMobile = computed(() => width.value < 768)
const currentStudyId = computed(() => studyStore.currentStudyId)

function selectedVisit(subject: FollowupSubject) {
  if (visitId.value) return subject.visits.find((visit) => visit.id === visitId.value) ?? null
  const applicable = subject.visits.filter((visit) => visit.expectedCount > 0)
  if (!applicable.length) return null
  const submittedCount = applicable.reduce((sum, visit) => sum + visit.submittedCount, 0)
  const expectedCount = applicable.reduce((sum, visit) => sum + visit.expectedCount, 0)
  const draftCount = applicable.reduce((sum, visit) => sum + visit.draftCount, 0)
  return {
    id: 'all',
    code: 'ALL',
    name: t('followups.allVisits'),
    expectedCount,
    submittedCount,
    draftCount,
    status:
      submittedCount >= expectedCount
        ? ('completed' as const)
        : submittedCount > 0 || draftCount > 0
          ? ('in_progress' as const)
          : ('not_started' as const),
    updatedAt: null,
  }
}

function statusPresentation(subject: FollowupSubject) {
  const visit = selectedVisit(subject)
  if (!visit || visit.expectedCount === 0)
    return {
      status: 'unconfigured',
      label: t('followups.statuses.unconfigured'),
      tone: 'neutral' as const,
    }
  if (visit.status === 'completed')
    return {
      status: 'completed',
      label: t('followups.statuses.completed'),
      tone: 'success' as const,
    }
  if (visit.status === 'in_progress')
    return {
      status: 'in_progress',
      label: t('followups.statuses.inProgress'),
      tone: 'warning' as const,
    }
  return {
    status: 'not_started',
    label: t('followups.statuses.notStarted'),
    tone: 'neutral' as const,
  }
}

const summary = computed(() => {
  const statuses = items.value.map((subject) => statusPresentation(subject).status)
  return {
    completed: statuses.filter((status) => status === 'completed').length,
    inProgress: statuses.filter((status) => status === 'in_progress').length,
    notStarted: statuses.filter((status) => status === 'not_started').length,
  }
})

async function load() {
  await studyStore.load()
  if (!currentStudyId.value) return
  loading.value = true
  try {
    const params = new URLSearchParams({ pageSize: '100' })
    if (query.value.trim()) params.set('query', query.value.trim())
    if (siteName.value) params.set('siteName', siteName.value)
    const response = await apiRequest<WorklistResponse>(
      `/studies/${currentStudyId.value}/followups?${params}`,
    )
    items.value = response.items
    visits.value = response.visits
    sites.value = response.sites
    total.value = response.total
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('followups.loadFailed'))
  } finally {
    loading.value = false
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(query, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(load, 300)
})
watch(siteName, load)
watch(siteName, (value) => siteScope.setCurrent(value))
watch(
  () => siteScope.currentSiteName,
  (value) => {
    if (siteName.value !== value) siteName.value = value
  },
)
watch(currentStudyId, load)

onMounted(load)
</script>

<template>
  <el-alert
    v-if="!currentStudyId"
    :title="t('subjects.selectStudy')"
    type="info"
    show-icon
    :closable="false"
  />
  <template v-else>
    <div class="toolbar followup-toolbar">
      <el-input v-model="query" :placeholder="t('followups.searchPlaceholder')" clearable />
      <el-select v-model="siteName" :placeholder="t('followups.allSites')" clearable>
        <el-option v-for="site in sites" :key="site.name" :label="site.name" :value="site.name" />
      </el-select>
      <el-select v-model="visitId" :placeholder="t('followups.allVisits')" clearable>
        <el-option
          v-for="visit in visits"
          :key="visit.id"
          :label="`${visit.code} · ${visit.name}`"
          :value="visit.id"
        />
      </el-select>
      <el-button @click="load">{{ t('followups.refresh') }}</el-button>
    </div>

    <section class="metric-grid followup-metrics" :aria-label="t('followups.overview')">
      <article class="metric-card">
        <span>{{ t('followups.subject') }}</span
        ><strong>{{ total }}</strong>
      </article>
      <article class="metric-card">
        <span>{{ t('followups.statuses.completed') }}</span
        ><strong>{{ summary.completed }}</strong>
      </article>
      <article class="metric-card">
        <span>{{ t('followups.statuses.inProgress') }}</span
        ><strong>{{ summary.inProgress }}</strong>
      </article>
      <article class="metric-card">
        <span>{{ t('followups.statuses.notStarted') }}</span
        ><strong>{{ summary.notStarted }}</strong>
      </article>
    </section>

    <section v-loading="loading" class="panel followup-panel">
      <el-table
        v-if="!isMobile"
        :data="items"
        style="width: 100%"
        :empty-text="t('followups.noMatches')"
      >
        <el-table-column :label="t('followups.subject')" min-width="160">
          <template #default="{ row }">
            <strong>{{ row.subject_number || row.screening_number }}</strong>
            <div class="muted-text">{{ row.screening_number }}</div>
          </template>
        </el-table-column>
        <el-table-column :label="t('followups.site')" min-width="170">
          <template #default="{ row }">{{ row.site_name }}</template>
        </el-table-column>
        <el-table-column :label="t('followups.completion')" min-width="180">
          <template #default="{ row }">
            <span v-if="selectedVisit(row)">{{
              t('followups.formsCount', {
                submitted: selectedVisit(row)?.submittedCount,
                expected: selectedVisit(row)?.expectedCount,
              })
            }}</span>
            <span v-else class="muted-text">{{ t('followups.noVisitForms') }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('followups.status')" width="110">
          <template #default="{ row }">
            <StatusPill
              :tone="statusPresentation(row).tone"
              :label="statusPresentation(row).label"
            />
          </template>
        </el-table-column>
        <el-table-column :label="t('followups.actions')" width="120" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link @click="router.push(`/subjects/${row.id}`)">
              {{ t('followups.enterOrView') }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-else class="followup-card-list">
        <article v-for="subject in items" :key="subject.id" class="followup-card">
          <header>
            <div>
              <strong>{{ subject.subject_number || subject.screening_number }}</strong
              ><span>{{ subject.site_name }}</span>
            </div>
            <VanTag
              :type="
                statusPresentation(subject).tone === 'success'
                  ? 'success'
                  : statusPresentation(subject).tone === 'warning'
                    ? 'warning'
                    : 'default'
              "
            >
              {{ statusPresentation(subject).label }}
            </VanTag>
          </header>
          <div class="followup-progress">
            <span>{{
              visitId
                ? visits.find((visit) => visit.id === visitId)?.name
                : t('followups.allVisits')
            }}</span>
            <strong
              >{{ selectedVisit(subject)?.submittedCount ?? 0 }} /
              {{ selectedVisit(subject)?.expectedCount ?? 0 }}</strong
            >
          </div>
          <VanButton type="primary" block @click="router.push(`/subjects/${subject.id}`)">
            {{ t('followups.enterOrView') }}
          </VanButton>
        </article>
        <div v-if="!loading && !items.length" class="empty-state">
          <p>{{ t('followups.noMatches') }}</p>
        </div>
      </div>
    </section>
  </template>
</template>

<style scoped>
.followup-toolbar {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) 220px 220px auto;
}
.followup-metrics {
  margin-bottom: 12px;
}
.followup-panel {
  overflow: hidden;
}
.followup-card-list {
  display: grid;
  gap: 10px;
  padding: 12px;
}
.followup-card {
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
}
.followup-card header,
.followup-progress {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.followup-card header div {
  display: grid;
  gap: 3px;
}
.followup-card header span,
.followup-progress span {
  color: var(--color-text-secondary);
  font-size: 13px;
}
.followup-progress {
  margin: 16px 0;
}
@media (max-width: 1100px) {
  .followup-toolbar {
    grid-template-columns: minmax(220px, 1fr) 180px 180px auto;
  }
}
@media (max-width: 767px) {
  .followup-toolbar {
    grid-template-columns: 1fr 1fr;
  }
  .followup-toolbar .el-input {
    grid-column: 1 / -1;
  }
  .followup-panel {
    border: 0;
    background: transparent;
  }
}
</style>
