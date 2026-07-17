import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import AppShell from '@/components/layout/AppShell.vue'
import { i18n } from './i18n'
import { pinia } from './pinia'
import { useAuthStore } from '@/modules/auth/auth.store'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/modules/auth/LoginView.vue'),
    meta: { public: true, titleKey: 'common.appName' },
  },
  {
    path: '/',
    component: AppShell,
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'dashboard',
        component: () => import('@/modules/dashboard/DashboardView.vue'),
        meta: { titleKey: 'nav.dashboard', nav: 'dashboard' },
      },
      {
        path: 'studies',
        name: 'studies',
        component: () => import('@/modules/studies/StudyListView.vue'),
        meta: { titleKey: 'nav.studies', nav: 'studies' },
      },
      {
        path: 'study-settings',
        name: 'study-settings',
        component: () => import('@/modules/studies/StudySettingsView.vue'),
        meta: { titleKey: 'nav.studySettings', nav: 'studySettings', desktopOnly: true },
      },
      {
        path: 'users',
        name: 'users',
        component: () => import('@/modules/users/UsersView.vue'),
        meta: { titleKey: 'nav.users', nav: 'users', desktopOnly: true, systemAdminOnly: true },
      },
      {
        path: 'subjects',
        name: 'subjects',
        component: () => import('@/modules/subjects/SubjectListView.vue'),
        meta: { titleKey: 'nav.subjects', nav: 'subjects' },
      },
      {
        path: 'subjects/new-screening',
        name: 'screening-create',
        component: () => import('@/modules/subjects/ScreeningCreateView.vue'),
        meta: { titleKey: 'nav.screening', nav: 'screening' },
      },
      {
        path: 'subjects/:id',
        name: 'subject-detail',
        component: () => import('@/modules/subjects/SubjectDetailView.vue'),
        meta: { titleKey: 'nav.subjects', nav: 'subjects' },
      },
      {
        path: 'followups',
        name: 'followups',
        component: () => import('@/modules/followups/FollowupWorklistView.vue'),
        meta: { titleKey: 'nav.followups', nav: 'followups' },
      },
      {
        path: 'forms',
        name: 'forms',
        component: () => import('@/modules/forms/FormListView.vue'),
        meta: { titleKey: 'nav.forms', nav: 'forms' },
      },
      {
        path: 'forms/designer/:id?',
        name: 'form-designer',
        component: () => import('@/modules/forms/FormDesignerView.vue'),
        meta: { titleKey: 'nav.forms', nav: 'forms', desktopOnly: true },
      },
      {
        path: 'randomization',
        name: 'randomization',
        component: () => import('@/modules/randomization/RandomizationView.vue'),
        meta: { titleKey: 'nav.randomization', nav: 'randomization', desktopOnly: true },
      },
      {
        path: 'members',
        name: 'members',
        component: () => import('@/modules/members/MembersView.vue'),
        meta: { titleKey: 'nav.members', nav: 'members', desktopOnly: true },
      },
      {
        path: 'sites',
        name: 'sites',
        component: () => import('@/modules/sites/SitesView.vue'),
        meta: { titleKey: 'nav.sites', nav: 'sites', desktopOnly: true },
      },
      {
        path: 'exports',
        name: 'exports',
        component: () => import('@/modules/exports/ExportsView.vue'),
        meta: { titleKey: 'nav.exports', nav: 'exports', desktopOnly: true },
      },
      {
        path: 'audit',
        name: 'audit',
        component: () => import('@/modules/audit/AuditView.vue'),
        meta: { titleKey: 'nav.audit', nav: 'audit', desktopOnly: true },
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/modules/settings/SettingsView.vue'),
        meta: { titleKey: 'nav.settings', nav: 'settings' },
      },
      {
        path: 'mine',
        name: 'mine',
        component: () => import('@/modules/settings/SettingsView.vue'),
        meta: { titleKey: 'nav.mine', nav: 'mine' },
      },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.beforeEach(async (to) => {
  const auth = useAuthStore(pinia)
  await auth.initialize()
  if (!to.meta.public && !auth.authenticated)
    return { name: 'login', query: { redirect: to.fullPath } }
  if (to.name === 'login' && auth.authenticated) return { name: 'dashboard' }
  if (to.meta.systemAdminOnly && !auth.user?.isSystemAdmin) return { name: 'dashboard' }
  if (to.meta.desktopOnly && window.matchMedia('(max-width: 767px)').matches)
    return { name: 'dashboard' }
  return true
})

router.afterEach((to) => {
  const key = to.meta.titleKey
  document.title = key ? `${i18n.global.t(String(key))} · Clinical Trial EDC` : 'Clinical Trial EDC'
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>('#main-content')?.focus({ preventScroll: true }),
  )
})

declare module 'vue-router' {
  interface RouteMeta {
    public?: boolean
    titleKey?: string
    nav?: string
    feature?: string
    desktopOnly?: boolean
  }
}
