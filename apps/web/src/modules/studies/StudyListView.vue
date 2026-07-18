<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ApiClientError } from '@/api/client'
import { useAuthStore } from '@/modules/auth/auth.store'
import { useStudyStore, type CreateStudyInput } from './study.store'
import StatusPill from '@/components/ui/StatusPill.vue'

const studies = useStudyStore()
const auth = useAuthStore()
const router = useRouter()
const { t } = useI18n()
const query = ref('')
const includeArchived = ref(false)
const dialogOpen = ref(false)
const editingStudyId = ref('')
const saving = ref(false)
const formRef = ref<FormInstance>()
const form = reactive({
  protocolCode: '',
  name: '',
  sponsor: '',
  studyType: '',
  phase: '',
  startDate: '',
  endDate: '',
  defaultLocale: 'zh-CN' as 'zh-CN' | 'en-US',
  notes: '',
})

const canCreate = computed(() => Boolean(auth.user?.isSystemAdmin))
const filteredStudies = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  if (!keyword) return studies.studies
  return studies.studies.filter((study) =>
    `${study.protocolCode} ${study.name} ${study.sponsor ?? ''}`
      .toLocaleLowerCase()
      .includes(keyword),
  )
})
const rules = computed<FormRules>(() => ({
  protocolCode: [{ required: true, message: t('studies.protocolRequired'), trigger: 'blur' }],
  name: [{ required: true, message: t('studies.nameRequired'), trigger: 'blur' }],
  endDate: [
    {
      validator: (_rule, value, callback) => {
        if (value && form.startDate && value < form.startDate)
          callback(new Error(t('studies.invalidDates')))
        else callback()
      },
      trigger: 'change',
    },
  ],
}))

const labels = computed(() => ({
  draft: t('studies.statuses.draft'),
  active: t('studies.statuses.active'),
  ended: t('studies.statuses.ended'),
  archived: t('studies.statuses.archived'),
}))
const tones = {
  draft: 'warning',
  active: 'success',
  ended: 'neutral',
  archived: 'neutral',
} as const

onMounted(() => studies.load(true, includeArchived.value))
watch(includeArchived, () => studies.load(true, includeArchived.value))

function resetForm() {
  Object.assign(form, {
    protocolCode: '',
    name: '',
    sponsor: '',
    studyType: '',
    phase: '',
    startDate: '',
    endDate: '',
    defaultLocale: 'zh-CN',
    notes: '',
  })
  editingStudyId.value = ''
  formRef.value?.clearValidate()
}

function enterStudy(id: string) {
  studies.setCurrent(id)
  router.push('/dashboard')
}

function openEdit(study: (typeof studies.studies)[number]) {
  editingStudyId.value = study.id
  Object.assign(form, {
    protocolCode: study.protocolCode,
    name: study.name,
    sponsor: study.sponsor ?? '',
    studyType: study.studyType ?? '',
    phase: study.phase ?? '',
    startDate: study.startDate ?? '',
    endDate: study.endDate ?? '',
    defaultLocale: study.defaultLocale,
    notes: study.notes ?? '',
  })
  dialogOpen.value = true
}

async function saveStudy() {
  if (!(await formRef.value?.validate())) return
  saving.value = true
  try {
    const input: CreateStudyInput = {
      protocolCode: form.protocolCode.trim(),
      name: form.name.trim(),
    }
    if (form.sponsor.trim()) input.sponsor = form.sponsor.trim()
    if (form.studyType.trim()) input.studyType = form.studyType.trim()
    if (form.phase.trim()) input.phase = form.phase.trim()
    if (form.startDate) input.startDate = form.startDate
    if (form.endDate) input.endDate = form.endDate
    input.defaultLocale = form.defaultLocale
    if (form.notes.trim()) input.notes = form.notes.trim()
    if (editingStudyId.value) {
      await studies.update(editingStudyId.value, input)
      ElMessage.success(t('studies.updated'))
    } else {
      const id = await studies.create(input)
      ElMessage.success(t('studies.created'))
      enterStudy(id)
    }
    dialogOpen.value = false
    resetForm()
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('studies.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function advanceStatus(study: (typeof studies.studies)[number]) {
  const next =
    study.status === 'draft' ? 'active' : study.status === 'active' ? 'ended' : 'archived'
  const actionLabels = {
    active: t('studies.statusActions.active'),
    ended: t('studies.statusActions.ended'),
    archived: t('studies.statusActions.archived'),
  } as const
  const confirmed = await ElMessageBox.confirm(
    next === 'archived' ? t('studies.archiveWarning') : t('studies.transitionWarning'),
    t('studies.actionTitle', { action: actionLabels[next], study: study.name }),
    {
      type: 'warning',
      confirmButtonText: actionLabels[next],
      cancelButtonText: t('common.cancel'),
    },
  ).catch(() => null)
  if (!confirmed) return
  try {
    await studies.changeStatus(study.id, next)
    ElMessage.success(t('studies.actionSucceeded', { action: actionLabels[next] }))
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('studies.statusFailed'))
  }
}
</script>

<template>
  <div class="toolbar">
    <el-input
      v-model="query"
      :placeholder="t('studies.searchPlaceholder')"
      clearable
      style="max-width: 320px"
    />
    <span class="toolbar-spacer" />
    <el-switch v-model="includeArchived" :active-text="t('studies.showArchived')" />
    <el-button v-if="canCreate" type="primary" @click="dialogOpen = true">
      {{ t('studies.createStudy') }}
    </el-button>
  </div>
  <section v-loading="studies.loading" class="study-grid">
    <article v-for="study in filteredStudies" :key="study.id" class="panel study-card">
      <header>
        <div>
          <span class="muted-text">{{ study.protocolCode }}</span>
          <h2>{{ study.name }}</h2>
        </div>
        <StatusPill :tone="tones[study.status]" :label="labels[study.status]" />
      </header>
      <p class="muted-text">{{ study.sponsor || t('studies.noSponsor') }}</p>
      <footer>
        <span>{{ study.startDate || t('studies.noStartDate') }}</span>
        <div class="study-actions">
          <el-button
            v-if="study.canManage && ['draft', 'active'].includes(study.status)"
            @click="openEdit(study)"
          >
            {{ t('studies.edit') }}
          </el-button>
          <el-button
            v-if="study.canManage && study.status !== 'archived'"
            plain
            @click="advanceStatus(study)"
          >
            {{
              study.status === 'draft'
                ? t('studies.start')
                : study.status === 'active'
                  ? t('studies.end')
                  : t('studies.archive')
            }}
          </el-button>
          <el-button type="primary" plain @click="enterStudy(study.id)">
            {{ t('studies.enter') }}
          </el-button>
        </div>
      </footer>
    </article>
    <div v-if="studies.loaded && !filteredStudies.length" class="panel empty-state">
      <div>
        <h2>{{ query ? t('studies.noMatches') : t('studies.noStudies') }}</h2>
        <p class="muted-text">
          {{ query ? t('studies.tryOtherKeywords') : t('studies.emptyHint') }}
        </p>
        <el-button v-if="canCreate && !query" type="primary" @click="dialogOpen = true">
          {{ t('studies.createStudy') }}
        </el-button>
      </div>
    </div>
  </section>

  <el-dialog
    v-model="dialogOpen"
    :title="editingStudyId ? t('studies.editStudy') : t('studies.createStudy')"
    width="min(600px, 92vw)"
    :close-on-click-modal="false"
    @closed="resetForm"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
      <div class="form-grid">
        <el-form-item :label="t('studies.protocolCode')" prop="protocolCode" required>
          <el-input v-model="form.protocolCode" maxlength="100" autocomplete="off" />
        </el-form-item>
        <el-form-item :label="t('studies.studyName')" prop="name" required>
          <el-input v-model="form.name" maxlength="300" />
        </el-form-item>
        <el-form-item :label="t('studies.sponsor')">
          <el-input v-model="form.sponsor" maxlength="300" />
        </el-form-item>
        <el-form-item :label="t('studies.studyType')">
          <el-input
            v-model="form.studyType"
            maxlength="100"
            :placeholder="t('studies.studyTypePlaceholder')"
          />
        </el-form-item>
        <el-form-item :label="t('studies.phase')">
          <el-input
            v-model="form.phase"
            maxlength="100"
            :placeholder="t('studies.phasePlaceholder')"
          />
        </el-form-item>
        <div />
        <el-form-item :label="t('studies.startDate')">
          <el-date-picker
            v-model="form.startDate"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item :label="t('studies.endDate')" prop="endDate">
          <el-date-picker
            v-model="form.endDate"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item :label="t('studies.defaultLanguage')">
          <el-select v-model="form.defaultLocale" style="width: 100%">
            <el-option :label="t('studies.chinese')" value="zh-CN" /><el-option
              label="English"
              value="en-US"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('studies.notes')" class="notes-field">
          <el-input
            v-model="form.notes"
            type="textarea"
            :rows="3"
            maxlength="4000"
            show-word-limit
          />
        </el-form-item>
      </div>
      <el-alert
        :title="editingStudyId ? t('studies.editHint') : t('studies.createHint')"
        type="info"
        show-icon
        :closable="false"
      />
    </el-form>
    <template #footer>
      <el-button @click="dialogOpen = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" @click="saveStudy">
        {{ editingStudyId ? t('studies.saveChanges') : t('studies.create') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.study-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(440px, 1fr));
  gap: 12px;
}
.study-card {
  padding: 16px;
}
.study-card header,
.study-card footer {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.study-actions {
  display: flex;
  flex-wrap: nowrap;
  justify-content: flex-end;
  gap: 8px;
}
.notes-field {
  grid-column: 1 / -1;
}
.study-card h2 {
  margin: 4px 0 0;
  font-size: 18px;
}
.study-card footer {
  align-items: center;
  flex-wrap: nowrap;
  margin-top: 24px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
}
.study-card footer > span {
  flex: 0 0 auto;
  white-space: nowrap;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 16px;
}
@media (max-width: 1100px) {
  .study-grid {
    grid-template-columns: repeat(auto-fit, minmax(440px, 1fr));
  }
}
@media (max-width: 767px) {
  .study-grid,
  .form-grid {
    grid-template-columns: 1fr;
  }
  .study-card footer {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .study-actions {
    flex-wrap: wrap;
  }
}
</style>
