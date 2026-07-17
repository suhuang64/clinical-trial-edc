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
import { getSubjectStatusPresentation, type SubjectStatus } from './subject-status-presentation'

interface SubjectRow {
  id: string
  screening_number: string
  subject_number: string | null
  random_number: string | null
  randomization_arm_id: string | null
  randomization_arm_label: string | null
  status: SubjectStatus
  site_name: string
  updated_at: string
}

interface SiteRow {
  name: string
}

const router = useRouter()
const { t, locale } = useI18n()
const studyStore = useStudyStore()
const siteScope = useSiteScopeStore()
const { width } = useViewport()
const query = ref('')
const status = ref('')
const siteName = ref('')
const subjects = ref<SubjectRow[]>([])
const sites = ref<SiteRow[]>([])
const total = ref(0)
const loading = ref(false)
const errorMessage = ref('')
const isMobile = computed(() => width.value < 768)
const currentStudyId = computed(() => studyStore.currentStudyId)

const statusOptions = computed<Array<{ value: SubjectStatus; label: string }>>(() => [
  { value: 'screening', label: t('subjects.statuses.screening') },
  { value: 'screen_failed', label: t('subjects.statuses.screenFailed') },
  { value: 'pending_enrollment', label: t('subjects.statuses.pendingEnrollment') },
  { value: 'enrolled', label: t('subjects.statuses.enrolled') },
  { value: 'completed', label: t('subjects.statuses.completed') },
  { value: 'withdrawn', label: t('subjects.statuses.withdrawn') },
  { value: 'lost_to_followup', label: t('subjects.statuses.lostToFollowup') },
])

function presentation(subject: SubjectRow) {
  const statusPresentation = getSubjectStatusPresentation(subject)
  return { ...statusPresentation, label: t(statusPresentation.labelKey) }
}

async function load() {
  await studyStore.load()
  if (!currentStudyId.value) return
  loading.value = true
  errorMessage.value = ''
  try {
    const params = new URLSearchParams({ pageSize: '100' })
    if (query.value.trim()) params.set('query', query.value.trim())
    if (status.value) params.set('status', status.value)
    if (siteName.value) params.set('siteName', siteName.value)
    const [subjectResponse, siteResponse] = await Promise.all([
      apiRequest<{ items: SubjectRow[]; total: number }>(
        `/studies/${currentStudyId.value}/subjects?${params}`,
      ),
      apiRequest<{ items: SiteRow[] }>(`/studies/${currentStudyId.value}/sites`),
    ])
    subjects.value = subjectResponse.items
    total.value = subjectResponse.total
    sites.value = siteResponse.items
  } catch (error) {
    errorMessage.value = error instanceof ApiClientError ? error.message : t('subjects.loadFailed')
    ElMessage.error(errorMessage.value)
  } finally {
    loading.value = false
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(query, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(load, 300)
})
watch([status, siteName, currentStudyId], load)
watch(
  () => siteScope.currentSiteName,
  (value) => {
    if (siteName.value !== value) siteName.value = value
  },
)
watch(siteName, (value) => siteScope.setCurrent(value))
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
    <div class="toolbar subject-toolbar">
      <el-input v-model="query" :placeholder="t('subjects.searchPlaceholder')" clearable />
      <el-select
        v-model="status"
        :aria-label="t('subjects.filterStatus')"
        :placeholder="t('subjects.allStatuses')"
        clearable
      >
        <el-option
          v-for="option in statusOptions"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>
      <el-select
        v-model="siteName"
        :aria-label="t('subjects.filterSite')"
        :placeholder="t('subjects.allSites')"
        clearable
      >
        <el-option v-for="site in sites" :key="site.name" :label="site.name" :value="site.name" />
      </el-select>
      <span class="toolbar-spacer" />
      <el-button v-if="!isMobile" @click="router.push('/exports')">
        {{ t('subjects.export') }}
      </el-button>
      <el-button type="primary" @click="router.push('/subjects/new-screening')">
        {{ t('subjects.newScreening') }}
      </el-button>
    </div>

    <el-alert v-if="errorMessage" :title="errorMessage" type="error" show-icon :closable="false">
      <template #default>
        <el-button link type="primary" @click="load">
          {{ t('subjects.reload') }}
        </el-button>
      </template>
    </el-alert>

    <section v-if="!isMobile" v-loading="loading" class="panel">
      <el-table
        :data="subjects"
        style="width: 100%"
        :empty-text="t('subjects.noMatches')"
        @row-click="(row: SubjectRow) => router.push(`/subjects/${row.id}`)"
      >
        <el-table-column
          prop="screening_number"
          :label="t('subjects.screeningNumber')"
          min-width="130"
        />
        <el-table-column :label="t('subjects.subjectNumber')" min-width="145">
          <template #default="{ row }">{{ row.subject_number || '—' }}</template>
        </el-table-column>
        <el-table-column :label="t('subjects.randomNumber')" min-width="130">
          <template #default="{ row }">{{ row.random_number || '—' }}</template>
        </el-table-column>
        <el-table-column :label="t('subjects.randomizationGroup')" min-width="140">
          <template #default="{ row }">
            <strong v-if="row.randomization_arm_label || row.randomization_arm_id">
              {{ row.randomization_arm_label || row.randomization_arm_id }}
            </strong>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('subjects.site')" min-width="180">
          <template #default="{ row }">{{ row.site_name }}</template>
        </el-table-column>
        <el-table-column :label="t('subjects.status')" min-width="120">
          <template #default="{ row }">
            <StatusPill :tone="presentation(row).tone" :label="presentation(row).label" />
          </template>
        </el-table-column>
        <el-table-column :label="t('subjects.updatedAt')" min-width="180">
          <template #default="{ row }">
            {{ new Date(row.updated_at).toLocaleString(locale) }}
          </template>
        </el-table-column>
        <el-table-column :label="t('subjects.actions')" width="90">
          <template #default="{ row }">
            <el-button link type="primary" @click.stop="router.push(`/subjects/${row.id}`)">
              {{ t('subjects.view') }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <footer class="list-footer">
        <span class="muted-text">{{ t('subjects.total', { count: total }) }}</span>
      </footer>
    </section>

    <section v-else v-loading="loading" class="subject-summary-list">
      <article v-for="subject in subjects" :key="subject.id" class="subject-card panel">
        <header>
          <div>
            <strong>{{ subject.subject_number || subject.screening_number }}</strong
            ><small>{{ subject.screening_number }} · {{ subject.site_name }}</small>
          </div>
          <VanTag :type="presentation(subject).mobileType">
            {{ presentation(subject).label }}
          </VanTag>
        </header>
        <dl>
          <div>
            <dt>{{ t('subjects.randomNumber') }}</dt>
            <dd>{{ subject.random_number || '—' }}</dd>
          </div>
          <div>
            <dt>{{ t('subjects.randomizationGroup') }}</dt>
            <dd>
              <strong v-if="subject.randomization_arm_label || subject.randomization_arm_id">
                {{ subject.randomization_arm_label || subject.randomization_arm_id }}
              </strong>
              <span v-else>—</span>
            </dd>
          </div>
          <div>
            <dt>{{ t('subjects.updatedAt') }}</dt>
            <dd>{{ new Date(subject.updated_at).toLocaleString(locale) }}</dd>
          </div>
        </dl>
        <VanButton type="primary" block @click="router.push(`/subjects/${subject.id}`)">
          {{ t('subjects.viewAndEnter') }}
        </VanButton>
      </article>
      <div v-if="!loading && !subjects.length" class="panel empty-state">
        <div>
          <h2>{{ t('subjects.noMatches') }}</h2>
          <p class="muted-text">{{ t('subjects.adjustOrCreate') }}</p>
        </div>
      </div>
    </section>
  </template>
</template>

<style scoped>
.subject-toolbar {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) 150px 220px auto auto auto;
}
.list-footer {
  padding: 12px 16px;
  border-top: 1px solid var(--color-border);
}
.subject-summary-list {
  display: grid;
  gap: 10px;
}
.subject-card {
  padding: 14px;
}
.subject-card header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.subject-card header div {
  display: grid;
  gap: 3px;
}
.subject-card dl {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin: 16px 0;
}
.subject-card dl div {
  display: grid;
  gap: 3px;
}
.subject-card dt {
  color: var(--color-text-secondary);
  font-size: 13px;
}
.subject-card dd {
  margin: 0;
}
@media (max-width: 1100px) {
  .subject-toolbar {
    grid-template-columns: minmax(200px, 1fr) 140px 180px auto auto;
  }
  .subject-toolbar .toolbar-spacer {
    display: none;
  }
}
@media (max-width: 900px) {
  .subject-toolbar {
    grid-template-columns: 1fr 1fr;
  }
  .subject-toolbar .el-input {
    grid-column: 1 / -1;
  }
}
</style>
