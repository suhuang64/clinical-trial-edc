<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { apiRequest, ApiClientError } from '@/api/client'
import { useStudyStore } from '@/modules/studies/study.store'
import { useSiteScopeStore } from '@/modules/studies/site-scope.store'

interface DashboardData {
  metrics: {
    screened: number
    enrolled: number
    randomized: number
    followupCompletionRate: number | null
    expectedFollowupRecords: number
    completedFollowupRecords: number
  }
  sites: Array<{
    name: string
    enrollment_target: number
    enrolled: number
  }>
  enrollmentTrend: Array<{ period: string; value: number }>
  statusDistribution: Array<{ status: string; value: number }>
  randomization: {
    arms: Array<{ id: string; label: string }>
    overall: { counts: Record<string, number>; total: number }
    sites: Array<{ name: string; counts: Record<string, number>; total: number }>
  }
  recentActivities: Array<{
    id: string
    action: string
    object_type: string
    object_id: string | null
    site_name: string | null
    created_at: string
  }>
}

const studyStore = useStudyStore()
const siteScope = useSiteScopeStore()
const { t, locale } = useI18n()
const loading = ref(false)
const error = ref('')
const data = ref<DashboardData | null>(null)

const statusLabels = computed<Record<string, string>>(() => ({
  screening: t('subjects.statuses.screening'),
  screen_failed: t('subjects.statuses.screenFailed'),
  pending_enrollment: t('subjects.statuses.pendingEnrollment'),
  enrolled: t('subjects.statuses.enrolled'),
  completed: t('subjects.statuses.completed'),
  withdrawn: t('subjects.statuses.withdrawn'),
  lost_to_followup: t('subjects.statuses.lostToFollowup'),
}))
const actionLabels = computed<Record<string, string>>(() => ({
  'subject.screening_created': t('audit.actions.screeningCreated'),
  'subject.screening_concluded': t('audit.actions.screeningConcluded'),
  'subject.enrolled': t('audit.actions.subjectEnrolled'),
  'subject_event.created': t('audit.actions.eventCreated'),
  'randomization.assigned': t('audit.actions.randomized'),
  'data_record.created': t('audit.actions.dataCreated'),
  'data_record.updated': t('audit.actions.dataUpdated'),
  'data_record.deleted': t('audit.actions.dataDeleted'),
  'file.uploaded': t('audit.actions.fileUploaded'),
  'file.deleted': t('audit.actions.fileDeleted'),
  'form.published': t('audit.actions.formPublished'),
  'export.completed': t('audit.actions.exportCompleted'),
  'export.failed': t('audit.actions.exportFailed'),
  'auth.login_failed': t('audit.actions.loginFailed'),
  'auth.login_succeeded': t('audit.actions.loginSucceeded'),
  'auth.logout': t('audit.actions.logout'),
  'user.registered': t('audit.actions.userRegistered'),
  'user.created': t('audit.actions.userCreated'),
  'user.updated': t('audit.actions.userUpdated'),
  'user.deleted': t('audit.actions.userDeleted'),
  'user.password_changed': t('audit.actions.passwordChanged'),
  'user.password_reset': t('audit.actions.passwordReset'),
  'user.preferences_updated': t('audit.actions.preferencesUpdated'),
  'user.profile_updated': t('audit.actions.profileUpdated'),
  'study.created': t('audit.actions.studyCreated'),
  'study.updated': t('audit.actions.studyUpdated'),
  'study.status_changed': t('audit.actions.studyStatusChanged'),
  'study.numbering_updated': t('audit.actions.numberingUpdated'),
  'site.created': t('audit.actions.siteCreated'),
  'site.updated': t('audit.actions.siteUpdated'),
  'site.status_changed': t('audit.actions.siteStatusChanged'),
  'visit.created': t('audit.actions.visitCreated'),
  'visit.updated': t('audit.actions.visitUpdated'),
  'visit.deleted': t('audit.actions.visitDeleted'),
  'member.created': t('audit.actions.memberCreated'),
  'member.updated': t('audit.actions.memberUpdated'),
  'form.copied': t('audit.actions.formCopied'),
  'form.draft_saved': t('audit.actions.formDraftSaved'),
  'form.exported': t('audit.actions.formExported'),
  'form.imported': t('audit.actions.formImported'),
  'form.migration_queued': t('audit.actions.formMigrationQueued'),
  'form.migration_retried': t('audit.actions.formMigrationRetried'),
  'randomization.scheme_activated': t('audit.actions.schemeActivated'),
  'subject.screening_updated': t('audit.actions.screeningUpdated'),
  'subject.deleted': t('audit.actions.subjectDeleted'),
  'dashboard.exported': t('audit.actions.dashboardExported'),
}))

const metrics = computed(() => {
  const values = data.value?.metrics
  if (!values) return []
  return [
    {
      label: t('dashboard.metrics.screened'),
      value: String(values.screened),
      note: t('dashboard.metrics.permissionScope'),
    },
    {
      label: t('dashboard.metrics.enrolled'),
      value: String(values.enrolled),
      note: t('dashboard.metrics.subjectNumberAssigned'),
    },
    {
      label: t('dashboard.metrics.randomized'),
      value: String(values.randomized),
      note: t('dashboard.metrics.randomNumberAssigned'),
    },
    {
      label: t('dashboard.metrics.followupRate'),
      value:
        values.followupCompletionRate === null
          ? t('dashboard.metrics.noPlan')
          : `${values.followupCompletionRate}%`,
      note: t('dashboard.metrics.plannedRecords', {
        completed: values.completedFollowupRecords,
        expected: values.expectedFollowupRecords,
      }),
    },
  ]
})

const trendPoints = computed(() => {
  const rows = data.value?.enrollmentTrend ?? []
  if (!rows.length) return ''
  const max = Math.max(...rows.map((row) => row.value), 1)
  return rows
    .map((row, index) => {
      const x = rows.length === 1 ? 50 : (index / (rows.length - 1)) * 100
      const y = 92 - (row.value / max) * 80
      return `${x},${y}`
    })
    .join(' ')
})

const randomizationRows = computed(() => {
  const distribution = data.value?.randomization
  if (!distribution) return []
  return [
    { name: t('dashboard.randomizationOverall'), ...distribution.overall, overall: true },
    ...distribution.sites.map((site) => ({ ...site, overall: false })),
  ]
})

function sitePercent(site: DashboardData['sites'][number]) {
  if (!site.enrollment_target) return site.enrolled ? 100 : 0
  return Math.min(100, Math.round((site.enrolled / site.enrollment_target) * 1000) / 10)
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(locale.value, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

async function load() {
  await studyStore.load()
  if (!studyStore.currentStudyId) {
    data.value = null
    error.value = ''
    return
  }
  loading.value = true
  error.value = ''
  try {
    const query = siteScope.currentSiteId
      ? `?${new URLSearchParams({ siteId: siteScope.currentSiteId })}`
      : ''
    data.value = await apiRequest<DashboardData>(
      `/studies/${studyStore.currentStudyId}/dashboard${query}`,
    )
  } catch (loadError) {
    data.value = null
    error.value =
      loadError instanceof ApiClientError ? loadError.message : t('dashboard.loadFailed')
  } finally {
    loading.value = false
  }
}

watch([() => studyStore.currentStudyId, () => siteScope.currentSiteId], load, { immediate: true })
</script>

<template>
  <div v-loading="loading" class="dashboard-page">
    <section v-if="!studyStore.currentStudyId && !loading" class="panel empty-state">
      <div>
        <h2>{{ t('dashboard.selectStudy') }}</h2>
        <p class="muted-text">{{ t('dashboard.scopeHint') }}</p>
        <RouterLink class="el-button el-button--primary" to="/studies">
          {{ t('dashboard.goToStudies') }}
        </RouterLink>
      </div>
    </section>

    <el-result v-else-if="error" icon="error" :title="t('dashboard.loadFailed')" :sub-title="error">
      <template #extra>
        <el-button type="primary" @click="load">{{ t('dashboard.retry') }}</el-button>
      </template>
    </el-result>

    <template v-else-if="data">
      <section class="metric-grid" :aria-label="t('dashboard.keyMetrics')">
        <article v-for="metric in metrics" :key="metric.label" class="metric-card panel">
          <div class="metric-label">{{ metric.label }}</div>
          <div class="metric-value">{{ metric.value }}</div>
          <div class="metric-trend">{{ metric.note }}</div>
        </article>
      </section>

      <section class="panel randomization-panel" aria-labelledby="randomization-title">
        <header class="panel-header">
          <div>
            <h2 id="randomization-title">{{ t('dashboard.randomizationDistribution') }}</h2>
            <p class="muted-text">{{ t('dashboard.randomizationDistributionHint') }}</p>
          </div>
        </header>
        <template v-if="data.randomization.arms.length">
          <el-table
            :data="randomizationRows"
            class="randomization-table"
            size="small"
            :aria-label="t('dashboard.randomizationDistributionTable')"
          >
            <el-table-column prop="name" :label="t('dashboard.siteName')" min-width="180">
              <template #default="{ row }">
                <strong v-if="row.overall">{{ row.name }}</strong>
                <span v-else>{{ row.name }}</span>
              </template>
            </el-table-column>
            <el-table-column
              v-for="arm in data.randomization.arms"
              :key="arm.id"
              :label="arm.label"
              min-width="120"
              align="right"
            >
              <template #default="{ row }">{{ row.counts[arm.id] ?? 0 }}</template>
            </el-table-column>
            <el-table-column
              prop="total"
              :label="t('dashboard.total')"
              min-width="90"
              align="right"
            />
          </el-table>
          <div class="randomization-cards">
            <article v-for="row in randomizationRows" :key="row.name" class="randomization-card">
              <header>
                <strong>{{ row.name }}</strong>
                <span>{{ t('dashboard.totalWithCount', { count: row.total }) }}</span>
              </header>
              <dl>
                <div v-for="arm in data.randomization.arms" :key="arm.id">
                  <dt>{{ arm.label }}</dt>
                  <dd>{{ row.counts[arm.id] ?? 0 }}</dd>
                </div>
              </dl>
            </article>
          </div>
        </template>
        <div v-else class="empty-state">
          <div>
            <h3>{{ t('dashboard.noRandomizationScheme') }}</h3>
            <p class="muted-text">{{ t('dashboard.noRandomizationSchemeHint') }}</p>
          </div>
        </div>
      </section>

      <section class="dashboard-grid">
        <article class="panel enrollment-panel">
          <header class="panel-header">
            <div>
              <h2>{{ t('dashboard.siteProgress') }}</h2>
              <p class="muted-text">{{ t('dashboard.filteredByPermission') }}</p>
            </div>
          </header>
          <div v-if="data.sites.length" class="site-progress-list">
            <div v-for="site in data.sites" :key="site.name" class="site-progress-row">
              <div class="site-progress-label">
                <strong>{{ site.name }}</strong>
                <span
                  >{{ site.enrolled }} /
                  {{ site.enrollment_target || t('dashboard.noTarget') }}</span
                >
              </div>
              <div
                class="progress-track"
                role="progressbar"
                :aria-label="t('dashboard.siteProgressLabel', { site: site.name })"
                :aria-valuenow="sitePercent(site)"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <span :style="{ width: `${sitePercent(site)}%` }" />
              </div>
              <span class="progress-value">{{ sitePercent(site) }}%</span>
            </div>
          </div>
          <div v-else class="empty-state">
            <div>
              <h3>{{ t('dashboard.noSites') }}</h3>
              <p class="muted-text">{{ t('dashboard.noSitesHint') }}</p>
            </div>
          </div>
          <el-table
            v-if="data.sites.length"
            :data="data.sites"
            class="accessible-table"
            size="small"
            :aria-label="t('dashboard.siteProgressTable')"
          >
            <el-table-column prop="name" :label="t('dashboard.siteName')" />
            <el-table-column prop="enrolled" :label="t('dashboard.enrolled')" />
            <el-table-column prop="enrollment_target" :label="t('dashboard.target')" />
          </el-table>
        </article>

        <article class="panel trend-panel">
          <header class="panel-header">
            <div>
              <h2>{{ t('dashboard.trend') }}</h2>
              <p class="muted-text">{{ t('dashboard.trendHint') }}</p>
            </div>
          </header>
          <div v-if="data.enrollmentTrend.length" class="trend-chart">
            <svg
              viewBox="0 0 100 100"
              role="img"
              :aria-label="t('dashboard.trendChart')"
              preserveAspectRatio="none"
            >
              <line x1="0" y1="92" x2="100" y2="92" />
              <polyline :points="trendPoints" />
            </svg>
            <div class="trend-labels">
              <span v-for="row in data.enrollmentTrend" :key="row.period"
                >{{ row.period }}<strong>{{ row.value }}</strong></span
              >
            </div>
          </div>
          <div v-else class="empty-state">
            <div>
              <h3>{{ t('dashboard.noTrend') }}</h3>
              <p class="muted-text">{{ t('dashboard.noTrendHint') }}</p>
            </div>
          </div>
          <table v-if="data.enrollmentTrend.length" class="sr-only-table">
            <caption>
              {{
                t('dashboard.trendData')
              }}
            </caption>
            <thead>
              <tr>
                <th>{{ t('dashboard.month') }}</th>
                <th>{{ t('dashboard.enrollmentCount') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in data.enrollmentTrend" :key="row.period">
                <td>{{ row.period }}</td>
                <td>{{ row.value }}</td>
              </tr>
            </tbody>
          </table>
        </article>

        <article class="panel status-panel">
          <header class="panel-header">
            <h2>{{ t('dashboard.subjectStatus') }}</h2>
          </header>
          <div v-if="data.statusDistribution.length" class="status-list">
            <div v-for="row in data.statusDistribution" :key="row.status">
              <span>{{ statusLabels[row.status] ?? row.status }}</span
              ><strong>{{ row.value }}</strong>
            </div>
          </div>
          <div v-else class="empty-state">
            <div>
              <h3>{{ t('dashboard.noSubjects') }}</h3>
              <p class="muted-text">{{ t('dashboard.noSubjectsHint') }}</p>
            </div>
          </div>
        </article>

        <article class="panel activity-panel">
          <header class="panel-header">
            <h2>{{ t('dashboard.recentActivity') }}</h2>
          </header>
          <ul v-if="data.recentActivities.length" class="activity-list">
            <li v-for="activity in data.recentActivities" :key="activity.id" class="activity-item">
              <span class="activity-dot" aria-hidden="true" />
              <div>
                <div>{{ actionLabels[activity.action] ?? activity.action }}</div>
                <small class="muted-text"
                  >{{ formatTime(activity.created_at) }} · {{ activity.object_type }}</small
                >
              </div>
            </li>
          </ul>
          <div v-else class="empty-state">
            <div>
              <h3>{{ t('dashboard.noActivity') }}</h3>
              <p class="muted-text">{{ t('dashboard.noActivityHint') }}</p>
            </div>
          </div>
        </article>
      </section>
    </template>
  </div>
</template>

<style scoped>
.dashboard-page {
  min-height: 360px;
}
.dashboard-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 12px;
}
.dashboard-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.randomization-panel {
  margin-bottom: 16px;
}
.randomization-table :deep(.cell) {
  font-variant-numeric: tabular-nums;
}
.randomization-cards {
  display: none;
}
.activity-list {
  padding-inline: 16px;
}
.panel-header {
  align-items: flex-start;
}
.panel-header h2,
.panel-header p {
  margin: 0;
}
.site-progress-list {
  display: grid;
  gap: 16px;
  padding: 16px;
}
.site-progress-row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(120px, 2fr) 56px;
  align-items: center;
  gap: 12px;
}
.site-progress-label {
  display: grid;
  gap: 2px;
}
.site-progress-label span,
.progress-value {
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}
.progress-track {
  height: 10px;
  overflow: hidden;
  border-radius: 5px;
  background: var(--color-surface-subtle);
  border: 1px solid var(--color-border);
}
.progress-track span {
  display: block;
  height: 100%;
  background: var(--color-primary);
}
.accessible-table {
  border-top: 1px solid var(--color-border);
}
.trend-chart {
  padding: 16px;
}
.trend-chart svg {
  width: 100%;
  height: 180px;
  overflow: visible;
}
.trend-chart line {
  stroke: var(--color-border);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.trend-chart polyline {
  fill: none;
  stroke: var(--color-primary);
  stroke-width: 3;
  vector-effect: non-scaling-stroke;
}
.trend-labels {
  display: flex;
  justify-content: space-between;
  gap: 4px;
  color: var(--color-text-secondary);
  font-size: 12px;
}
.trend-labels span {
  display: grid;
  text-align: center;
}
.trend-labels strong {
  color: var(--color-text);
}
.status-list {
  display: grid;
  gap: 0;
  padding: 8px 16px 16px;
}
.status-list > div {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--color-border);
}
.sr-only-table {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
@media (max-width: 1100px) {
  .dashboard-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 767px) {
  .desktop-export-action {
    display: none;
  }
  .site-progress-row {
    grid-template-columns: 1fr auto;
  }
  .progress-track {
    grid-column: 1 / -1;
    grid-row: 2;
    height: 12px;
  }
  .progress-value {
    grid-column: 2;
    grid-row: 1;
  }
  .accessible-table {
    display: none;
  }
  .randomization-table {
    display: none;
  }
  .randomization-cards {
    display: grid;
    gap: 12px;
    padding: 0 16px 16px;
  }
  .randomization-card {
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 12px;
  }
  .randomization-card header,
  .randomization-card dl > div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  .randomization-card header {
    padding-bottom: 8px;
    border-bottom: 1px solid var(--color-border);
  }
  .randomization-card header span,
  .randomization-card dt {
    color: var(--color-text-secondary);
  }
  .randomization-card dl {
    display: grid;
    gap: 8px;
    margin: 12px 0 0;
  }
  .randomization-card dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  .trend-labels {
    overflow-x: auto;
    justify-content: flex-start;
  }
  .trend-labels span {
    min-width: 64px;
  }
}
</style>
