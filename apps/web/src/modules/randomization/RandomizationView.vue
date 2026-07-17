<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { apiRequest, ApiClientError } from '@/api/client'
import { useStudyStore } from '@/modules/studies/study.store'
import StatusPill from '@/components/ui/StatusPill.vue'

type Method = 'simple' | 'permuted_block' | 'stratified_block' | 'minimization'
interface Arm {
  id: string
  label: string
  weight: number
}
interface SchemeRow {
  id: string
  name: string
  method: Method
  arms_json: string
  config_json: string
  status: 'draft' | 'active' | 'frozen' | 'disabled'
  sequence_position: number
  activated_at: string | null
  frozen_at: string | null
}
interface SimulationRow {
  armId: string
  label: string
  count: number
  percent: number
}

const studyStore = useStudyStore()
const { t } = useI18n()
const loading = ref(false)
const saving = ref(false)
const simulating = ref(false)
const canManage = ref(false)
const schemeStatus = ref<'none' | 'draft' | 'active' | 'frozen'>('none')
const sequencePosition = ref(0)
const simulation = ref<SimulationRow[]>([])
const sampleSize = ref(200)
const form = reactive({
  name: t('randomization.defaultName'),
  method: 'stratified_block' as Method,
  arms: [
    { id: 'A', label: t('randomization.armA'), weight: 1 },
    { id: 'B', label: t('randomization.armB'), weight: 1 },
  ] as Arm[],
  blockSizes: [4, 6] as number[],
  factorKeys: ['site'] as string[],
  biasProbability: 0.8,
  seedMode: 'auto' as 'auto' | 'manual',
  seed: '',
})

const methodHelp = computed(
  () =>
    ({
      simple: t('randomization.methodHelp.simple'),
      permuted_block: t('randomization.methodHelp.permutedBlock'),
      stratified_block: t('randomization.methodHelp.stratifiedBlock'),
      minimization: t('randomization.methodHelp.minimization'),
    })[form.method],
)
const frozen = computed(() => schemeStatus.value === 'frozen')
const editable = computed(() => canManage.value && !frozen.value)
const statusLabel = computed(
  () =>
    ({
      none: t('randomization.statuses.none'),
      draft: t('randomization.statuses.draft'),
      active: t('randomization.statuses.active'),
      frozen: t('randomization.statuses.frozen'),
    })[schemeStatus.value],
)
const statusTone = computed<'neutral' | 'warning' | 'success'>(() =>
  schemeStatus.value === 'frozen' || schemeStatus.value === 'active'
    ? 'success'
    : schemeStatus.value === 'draft'
      ? 'warning'
      : 'neutral',
)

function payload() {
  return {
    name: form.name,
    method: form.method,
    arms: form.arms,
    config: {
      ...(form.method.includes('block') ? { blockSizes: form.blockSizes } : {}),
      ...(['stratified_block', 'minimization'].includes(form.method)
        ? {
            factorKeys: form.factorKeys,
            factorWeights: Object.fromEntries(form.factorKeys.map((key) => [key, 1])),
          }
        : {}),
      ...(form.method === 'minimization' ? { biasProbability: form.biasProbability } : {}),
    },
    ...(form.seedMode === 'manual' && form.seed ? { seed: form.seed } : {}),
  }
}

async function load() {
  await studyStore.load()
  if (!studyStore.currentStudyId) return
  loading.value = true
  try {
    const response = await apiRequest<{ scheme: SchemeRow | null; canManage: boolean }>(
      `/studies/${studyStore.currentStudyId}/randomization/scheme`,
    )
    canManage.value = response.canManage
    if (!response.scheme) {
      schemeStatus.value = 'none'
      return
    }
    const arms = JSON.parse(response.scheme.arms_json) as Arm[]
    const config = JSON.parse(response.scheme.config_json) as {
      blockSizes?: number[]
      factorKeys?: string[]
      biasProbability?: number
    }
    form.name = response.scheme.name
    form.method = response.scheme.method
    form.arms = arms
    form.blockSizes = config.blockSizes ?? [4]
    form.factorKeys = config.factorKeys ?? []
    form.biasProbability = config.biasProbability ?? 0.8
    form.seedMode = 'auto'
    form.seed = ''
    schemeStatus.value = response.scheme.status === 'disabled' ? 'draft' : response.scheme.status
    sequencePosition.value = response.scheme.sequence_position
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('randomization.loadFailed'))
  } finally {
    loading.value = false
  }
}

function addArm() {
  form.arms.push({
    id: `G${form.arms.length + 1}`,
    label: t('randomization.armNumber', { number: form.arms.length + 1 }),
    weight: 1,
  })
}
function removeArm(index: number) {
  if (form.arms.length > 2) form.arms.splice(index, 1)
}

async function save(showMessage = true) {
  if (!studyStore.currentStudyId) return false
  saving.value = true
  try {
    await apiRequest(`/studies/${studyStore.currentStudyId}/randomization/scheme`, {
      method: 'PUT',
      body: JSON.stringify(payload()),
    })
    schemeStatus.value = 'draft'
    if (showMessage) ElMessage.success(t('randomization.draftSaved'))
    return true
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('randomization.saveFailed'))
    return false
  } finally {
    saving.value = false
  }
}

async function activate() {
  if (!(await save(false)) || !studyStore.currentStudyId) return
  const confirmed = await ElMessageBox.confirm(
    t('randomization.activateWarning'),
    t('randomization.activateTitle'),
    {
      type: 'warning',
      confirmButtonText: t('randomization.confirmActivate'),
      cancelButtonText: t('common.cancel'),
    },
  ).catch(() => null)
  if (!confirmed) return
  saving.value = true
  try {
    await apiRequest(`/studies/${studyStore.currentStudyId}/randomization/scheme/activate`, {
      method: 'POST',
    })
    schemeStatus.value = 'active'
    ElMessage.success(t('randomization.activated'))
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('randomization.activateFailed'),
    )
  } finally {
    saving.value = false
  }
}

async function simulate() {
  if (!studyStore.currentStudyId) return
  simulating.value = true
  try {
    const response = await apiRequest<{ results: SimulationRow[] }>(
      `/studies/${studyStore.currentStudyId}/randomization/scheme/simulate`,
      { method: 'POST', body: JSON.stringify({ ...payload(), sampleSize: sampleSize.value }) },
    )
    simulation.value = response.results
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('randomization.simulationFailed'),
    )
  } finally {
    simulating.value = false
  }
}

watch(() => studyStore.currentStudyId, load, { immediate: true })
</script>

<template>
  <div v-loading="loading">
    <section v-if="!studyStore.currentStudyId" class="panel empty-state">
      <div>
        <h2>{{ t('randomization.selectStudy') }}</h2>
        <p class="muted-text">{{ t('randomization.studyScopeHint') }}</p>
      </div>
    </section>
    <template v-else>
      <el-alert
        v-if="frozen"
        :title="t('randomization.frozenAlert')"
        type="success"
        show-icon
        :closable="false"
        class="scheme-alert"
      />
      <el-alert
        v-else
        :title="t('randomization.freezeWarning')"
        type="warning"
        show-icon
        :closable="false"
        class="scheme-alert"
      />
      <div class="randomization-layout">
        <section class="panel">
          <header class="panel-header">
            <h2>{{ t('randomization.title') }}</h2>
            <StatusPill :tone="statusTone" :label="statusLabel" />
          </header>
          <div class="panel-body">
            <el-form label-position="top" :disabled="!editable">
              <el-form-item :label="t('randomization.name')" required>
                <el-input v-model="form.name" maxlength="200" />
              </el-form-item>
              <el-form-item :label="t('randomization.method')" required>
                <el-select v-model="form.method" style="width: 100%">
                  <el-option :label="t('randomization.methods.simple')" value="simple" /><el-option
                    :label="t('randomization.methods.permutedBlock')"
                    value="permuted_block"
                  /><el-option
                    :label="t('randomization.methods.stratifiedBlock')"
                    value="stratified_block"
                  /><el-option
                    :label="t('randomization.methods.minimization')"
                    value="minimization"
                  />
                </el-select>
                <div class="muted-text">{{ methodHelp }}</div>
              </el-form-item>
              <el-divider content-position="left">
                {{ t('randomization.armsAndRatios') }}
              </el-divider>
              <div class="arm-list">
                <div v-for="(arm, index) in form.arms" :key="index" class="arm-row">
                  <el-input
                    v-model="arm.id"
                    :aria-label="t('randomization.armId')"
                    placeholder="ID"
                  /><el-input
                    v-model="arm.label"
                    :aria-label="t('randomization.armName')"
                    :placeholder="t('randomization.displayName')"
                  /><el-input-number
                    v-model="arm.weight"
                    :aria-label="t('randomization.allocationRatio')"
                    :min="1"
                  /><el-button
                    type="danger"
                    plain
                    :disabled="form.arms.length <= 2"
                    @click="removeArm(index)"
                  >
                    {{ t('randomization.remove') }}
                  </el-button>
                </div>
              </div>
              <el-button class="add-arm" :disabled="form.arms.length >= 10" @click="addArm">
                {{ t('randomization.addArm') }}
              </el-button>
              <el-form-item
                v-if="form.method.includes('block')"
                :label="t('randomization.blockSizes')"
              >
                <el-select v-model="form.blockSizes" multiple style="width: 100%">
                  <el-option
                    v-for="size in [2, 4, 6, 8, 10, 12]"
                    :key="size"
                    :label="size"
                    :value="size"
                  />
                </el-select>
              </el-form-item>
              <el-form-item
                v-if="['stratified_block', 'minimization'].includes(form.method)"
                :label="t('randomization.factors')"
              >
                <el-checkbox-group v-model="form.factorKeys">
                  <el-checkbox value="site">{{ t('randomization.factorLabels.site') }}</el-checkbox
                  ><el-checkbox value="sex">{{ t('randomization.factorLabels.sex') }}</el-checkbox
                  ><el-checkbox value="age_group">
                    {{ t('randomization.factorLabels.ageGroup') }} </el-checkbox
                  ><el-checkbox value="disease_stage">
                    {{ t('randomization.factorLabels.diseaseStage') }}
                  </el-checkbox>
                </el-checkbox-group>
              </el-form-item>
              <el-form-item
                v-if="form.method === 'minimization'"
                :label="t('randomization.biasProbability')"
              >
                <el-slider
                  v-model="form.biasProbability"
                  :min="0.5"
                  :max="1"
                  :step="0.05"
                  show-input
                />
              </el-form-item>
              <el-form-item :label="t('randomization.seed')">
                <el-radio-group v-model="form.seedMode">
                  <el-radio value="auto">{{ t('randomization.automaticSeed') }}</el-radio
                  ><el-radio value="manual">
                    {{ t('randomization.manualSeed') }}
                  </el-radio> </el-radio-group
                ><el-input
                  v-if="form.seedMode === 'manual'"
                  v-model="form.seed"
                  type="password"
                  show-password
                  minlength="16"
                  :placeholder="t('randomization.seedPlaceholder')"
                />
              </el-form-item>
              <div class="toolbar">
                <span class="muted-text">{{
                  t('randomization.allocations', { count: sequencePosition })
                }}</span
                ><span class="toolbar-spacer" /><el-button :loading="saving" @click="save()">
                  {{ t('randomization.saveDraft') }} </el-button
                ><el-button type="primary" :loading="saving" @click="activate">
                  {{ t('randomization.validateAndActivate') }}
                </el-button>
              </div>
            </el-form>
          </div>
        </section>
        <aside class="panel simulation-panel">
          <header class="panel-header">
            <h2>{{ t('randomization.simulationTitle') }}</h2>
          </header>
          <div class="panel-body">
            <p class="muted-text">
              {{ t('randomization.simulationHint') }}
            </p>
            <el-form-item :label="t('randomization.sampleSize')">
              <el-input-number v-model="sampleSize" :min="10" :max="10000" :step="50" />
            </el-form-item>
            <div v-if="simulation.length" class="simulation">
              <div v-for="row in simulation" :key="row.armId">
                <strong>{{ row.count }}</strong
                ><span>{{ row.label }}</span
                ><small>{{ row.percent }}%</small>
              </div>
            </div>
            <div v-else class="empty-state simulation-empty">
              <div>
                <h3>{{ t('randomization.notSimulated') }}</h3>
                <p class="muted-text">{{ t('randomization.notSimulatedHint') }}</p>
              </div>
            </div>
            <el-button style="width: 100%" :loading="simulating" @click="simulate">
              {{ t('randomization.runSimulation') }}
            </el-button>
          </div>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.scheme-alert {
  margin-bottom: 12px;
}
.randomization-layout {
  display: grid;
  grid-template-columns: minmax(500px, 1.5fr) minmax(280px, 0.7fr);
  gap: 16px;
}
.arm-list {
  display: grid;
  gap: 8px;
}
.arm-row {
  display: grid;
  grid-template-columns: 100px minmax(150px, 1fr) 140px auto;
  gap: 8px;
  align-items: center;
}
.add-arm {
  margin: 8px 0 18px;
}
.simulation {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 10px;
  margin: 20px 0;
}
.simulation div {
  display: grid;
  gap: 4px;
  padding: 18px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: var(--color-surface-subtle);
  text-align: center;
}
.simulation strong {
  font-size: 28px;
}
.simulation span,
.simulation small {
  color: var(--color-text-secondary);
}
.simulation-empty {
  min-height: 180px;
}
@media (max-width: 1050px) {
  .randomization-layout {
    grid-template-columns: 1fr;
  }
  .arm-row {
    grid-template-columns: 90px minmax(130px, 1fr) 130px auto;
  }
}
</style>
