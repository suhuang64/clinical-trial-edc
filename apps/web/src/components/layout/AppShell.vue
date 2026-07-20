<script setup lang="ts">
import {
  Avatar,
  DataAnalysis,
  Document,
  FolderOpened,
  House,
  Menu as MenuIcon,
  Moon,
  Operation,
  Setting,
  Sunny,
  User,
  UserFilled,
} from '@element-plus/icons-vue'
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useViewport } from '@/composables/useViewport'
import { usePreferencesStore } from '@/modules/settings/preferences.store'
import { useAuthStore } from '@/modules/auth/auth.store'
import { useStudyStore } from '@/modules/studies/study.store'
import { useSiteScopeStore } from '@/modules/studies/site-scope.store'
import { apiRequest, ApiClientError } from '@/api/client'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const preferences = usePreferencesStore()
const auth = useAuthStore()
const studies = useStudyStore()
const siteScope = useSiteScopeStore()
const { width, coarsePointer } = useViewport()
const collapsed = ref(false)
const allSitesOptionValue = '__all_sites__'

const isMobile = computed(() => width.value < 768)
const isTabletLike = computed(
  () => width.value >= 768 && width.value <= 1366 && coarsePointer.value,
)
const sidebarCollapsed = computed(
  () => collapsed.value || (width.value >= 768 && width.value <= 1024) || isTabletLike.value,
)

const navigation = [
  { key: 'dashboard', path: '/dashboard', icon: House },
  { key: 'studies', path: '/studies', icon: FolderOpened },
  { key: 'studySettings', path: '/study-settings', icon: Setting, permission: 'study.manage' },
  { key: 'users', path: '/users', icon: User },
  { key: 'subjects', path: '/subjects', icon: UserFilled, permission: 'subject.view' },
  { key: 'forms', path: '/forms', icon: Operation, permission: 'form.manage' },
  {
    key: 'sites',
    path: '/sites',
    icon: House,
    permission: 'site.manage',
  },
  {
    key: 'randomization',
    path: '/randomization',
    icon: DataAnalysis,
    permission: 'randomization.manage',
  },
  { key: 'visits', path: '/visits', icon: Document, permission: 'site.manage' },
  { key: 'members', path: '/members', icon: User, permission: 'member.view' },
  { key: 'exports', path: '/exports', icon: FolderOpened, permission: 'export.execute' },
  { key: 'audit', path: '/audit', icon: Document, permission: 'audit.view' },
  { key: 'settings', path: '/settings', icon: Setting },
]
const desktopNavigation = computed(() =>
  navigation.filter(
    (item) =>
      (item.key !== 'users' || auth.user?.isSystemAdmin) &&
      (!item.permission || studies.can(item.permission)),
  ),
)

const mobileNavigation = [
  { key: 'dashboard', path: '/dashboard', icon: House },
  { key: 'subjects', path: '/subjects', icon: UserFilled, permission: 'subject.view' },
  {
    key: 'screening',
    path: '/subjects/new-screening',
    icon: Operation,
    permission: 'subject.create',
  },
  { key: 'mine', path: '/mine', icon: Avatar },
]
const visibleMobileNavigation = computed(() =>
  mobileNavigation.filter((item) => !item.permission || studies.can(item.permission)),
)

const activeNav = computed(() => String(route.meta.nav ?? 'dashboard'))
const pageTitle = computed(() => t(String(route.meta.titleKey ?? 'common.appName')))
const selectedSiteId = computed(() => siteScope.currentSiteId || allSitesOptionValue)

async function navigate(item: (typeof navigation)[number]) {
  if (item.key === 'randomization' && studies.currentStudyId) {
    try {
      const [sites, forms] = await Promise.all([
        apiRequest<{ items: Array<{ status: string }> }>(
          `/studies/${studies.currentStudyId}/sites`,
        ),
        apiRequest<{ items: Array<{ form_type: string }> }>(
          `/studies/${studies.currentStudyId}/forms`,
        ),
      ])
      if (!sites.items.some((site) => site.status === 'active')) {
        ElMessage.warning(t('common.randomizationNeedsSite'))
        return
      }
      if (!forms.items.some((form) => form.form_type === 'screening')) {
        ElMessage.warning(t('common.randomizationNeedsScreeningForm'))
        return
      }
    } catch (error) {
      ElMessage.error(error instanceof ApiClientError ? error.message : t('common.loadFailed'))
      return
    }
  }
  await router.push(item.path)
}

async function savePreferences(locale = preferences.locale, theme = preferences.theme) {
  try {
    await apiRequest('/auth/preferences', {
      method: 'PUT',
      body: JSON.stringify({ locale, theme }),
    })
    preferences.setLocale(locale)
    preferences.setTheme(theme)
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('common.preferenceSaveFailed'),
    )
  }
}

function toggleTheme() {
  void savePreferences(preferences.locale, preferences.resolvedTheme === 'dark' ? 'light' : 'dark')
}

function changeSite(value: string) {
  siteScope.setCurrent(value === allSitesOptionValue ? '' : value)
}

async function changeStudy(studyId: string) {
  if (!studyId || studyId === studies.currentStudyId) return
  const protectedRoutes = new Set(['subject-detail', 'screening-create', 'form-designer'])
  if (protectedRoutes.has(String(route.name))) {
    const confirmed = await ElMessageBox.confirm(
      t('common.studySwitchWarning'),
      t('common.studySwitchTitle'),
      {
        type: 'warning',
        confirmButtonText: t('common.confirmSwitch'),
        cancelButtonText: t('common.cancelSwitch'),
      },
    ).catch(() => false)
    if (!confirmed) return
  }
  studies.setCurrent(studyId)
  siteScope.setCurrent('')
  await siteScope.load(studyId, true)
  if (
    !['dashboard', 'studies', 'study-settings', 'users', 'settings', 'mine'].includes(
      String(route.name),
    )
  )
    await router.push('/dashboard')
}

async function logout() {
  await auth.logout()
  await router.push('/login')
}

watch(
  () => studies.currentStudyId,
  (studyId) => siteScope.load(studyId),
  { immediate: true },
)
onMounted(() => studies.load())
</script>

<template>
  <div class="app-shell" :class="{ 'is-mobile': isMobile, 'is-tablet-like': isTabletLike }">
    <a class="skip-link" href="#main-content">{{ t('common.skipToContent') }}</a>
    <aside v-if="!isMobile" class="app-sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">O</span>
        <span v-if="!sidebarCollapsed" class="brand-name">{{ t('common.appName') }}</span>
      </div>
      <nav class="sidebar-nav" :aria-label="t('common.mainNavigation')">
        <RouterLink
          v-for="item in desktopNavigation"
          v-slot="{ href }"
          :key="item.key"
          :to="item.path"
          custom
        >
          <a
            :href="href"
            class="nav-item"
            :class="{ active: activeNav === item.key }"
            :aria-label="t(`nav.${item.key}`)"
            @click.prevent="navigate(item)"
          >
            <el-icon><component :is="item.icon" /></el-icon>
            <span v-if="!sidebarCollapsed">{{ t(`nav.${item.key}`) }}</span>
          </a>
        </RouterLink>
      </nav>
      <button
        v-if="!isTabletLike"
        class="sidebar-collapse"
        type="button"
        :aria-label="collapsed ? t('common.expandSidebar') : t('common.collapseSidebar')"
        @click="collapsed = !collapsed"
      >
        <el-icon><MenuIcon /></el-icon>
      </button>
    </aside>

    <div class="app-workspace">
      <header class="topbar">
        <div class="topbar-title">
          <span class="context-label">{{ t('common.currentStudy') }}</span>
          <el-select
            v-if="studies.studies.length"
            class="study-select"
            :model-value="studies.currentStudyId"
            :aria-label="t('common.switchStudy')"
            @update:model-value="changeStudy"
          >
            <el-option
              v-for="study in studies.studies"
              :key="study.id"
              :label="study.name"
              :value="study.id"
            />
          </el-select>
          <el-select
            v-if="studies.currentStudyId"
            class="site-select"
            :model-value="selectedSiteId"
            :loading="siteScope.loading"
            :aria-label="t('common.switchSite')"
            @update:model-value="changeSite"
          >
            <el-option :label="t('common.allSites')" :value="allSitesOptionValue" />
            <el-option
              v-for="site in siteScope.sites"
              :key="site.id"
              :label="site.name"
              :value="site.id"
            />
          </el-select>
          <button v-else class="study-switcher" type="button" @click="router.push('/studies')">
            {{ t('common.selectOrCreateStudy') }}
          </button>
        </div>
        <div class="topbar-actions">
          <el-dropdown @command="(value: 'zh-CN' | 'en-US') => savePreferences(value)">
            <button class="language-button" type="button" :aria-label="t('common.switchLanguage')">
              {{ preferences.locale === 'zh-CN' ? '中' : 'EN' }}
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="zh-CN">简体中文</el-dropdown-item>
                <el-dropdown-item command="en-US">English</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <button
            class="icon-button"
            type="button"
            :aria-label="t('common.toggleTheme')"
            @click="toggleTheme"
          >
            <el-icon><Moon v-if="preferences.resolvedTheme === 'light'" /><Sunny v-else /></el-icon>
          </button>
          <el-dropdown>
            <button class="user-button" type="button" :aria-label="t('common.userMenu')">
              <el-icon class="user-avatar" aria-hidden="true"><Avatar /></el-icon>
              <span v-if="width >= 1024">{{ auth.user?.displayName ?? t('common.user') }}</span>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="router.push('/settings')">
                  {{ t('common.personalSettings') }} </el-dropdown-item
                ><el-dropdown-item divided @click="logout">
                  {{ t('common.logout') }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <main id="main-content" class="page-container" tabindex="-1">
        <div class="page-heading">
          <div>
            <h1>{{ pageTitle }}</h1>
            <p
              v-if="route.name === 'dashboard' && studies.currentStudy"
              class="page-heading-study muted-text"
            >
              {{ studies.currentStudy.name }}
            </p>
          </div>
          <slot name="page-action" />
        </div>
        <RouterView />
      </main>
    </div>

    <nav v-if="isMobile" class="mobile-nav" :aria-label="t('common.mobileNavigation')">
      <button
        v-for="item in visibleMobileNavigation"
        :key="item.key"
        type="button"
        class="mobile-nav-item"
        :class="{ active: activeNav === item.key }"
        @click="router.push(item.path)"
      >
        <el-icon><component :is="item.icon" /></el-icon>
        <span>{{ t(`nav.${item.key}`) }}</span>
      </button>
    </nav>
  </div>
</template>
