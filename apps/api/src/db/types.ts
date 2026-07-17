import type { ColumnType } from 'kysely'

type Timestamp = ColumnType<string, string | undefined, string>

export interface UserTable {
  id: string
  username: string
  display_name: string
  password_hash: string
  is_system_admin: number
  status: 'active' | 'disabled' | 'locked'
  failed_login_count: number
  locked_until: string | null
  locale: 'zh-CN' | 'en-US'
  theme: 'light' | 'dark' | 'system'
  created_at: Timestamp
  updated_at: Timestamp
}

export interface SessionTable {
  id: string
  user_id: string
  token_hash: string
  csrf_token_hash: string
  expires_at: string
  last_seen_at: Timestamp
  created_at: Timestamp
}

export interface StudyTable {
  id: string
  protocol_code: string
  name: string
  sponsor: string | null
  study_type: string | null
  phase: string | null
  status: 'draft' | 'active' | 'ended' | 'archived'
  start_date: string | null
  end_date: string | null
  default_locale: 'zh-CN' | 'en-US'
  notes: string | null
  created_by: string
  created_at: Timestamp
  updated_at: Timestamp
}

export interface SiteTable {
  name: string
  study_id: string
  principal_investigator: string | null
  contact_name: string | null
  contact_phone: string | null
  contact_email: string | null
  enrollment_target: number
  status: 'active' | 'disabled'
  created_at: Timestamp
  updated_at: Timestamp
}

export interface MembershipTable {
  id: string
  study_id: string
  user_id: string
  role_code: string
  status: 'active' | 'disabled'
  created_at: Timestamp
  updated_at: Timestamp
}

export interface MembershipSiteTable {
  membership_id: string
  site_name: string
}

export interface RoleTable {
  code: string
  name_zh: string
  name_en: string
}

export interface PermissionTable {
  code: string
  domain: string
  name_zh: string
  name_en: string
}

export interface RolePermissionTable {
  role_code: string
  permission_code: string
}

export interface MembershipPermissionOverrideTable {
  membership_id: string
  permission_code: string
  effect: 'allow' | 'deny'
}

export interface AuditEventTable {
  id: string
  request_id: string
  actor_user_id: string | null
  study_id: string | null
  site_name: string | null
  subject_id: string | null
  object_type: string
  object_id: string | null
  action: string
  before_json: string | null
  after_json: string | null
  reason: string | null
  ip_address: string | null
  user_agent: string | null
  created_at: Timestamp
}

export interface VisitDefinitionTable {
  id: string
  study_id: string
  code: string
  name: string
  sort_order: number
}

export interface UploadedFileTable {
  id: string
  study_id: string
  site_name: string
  subject_id: string
  record_id: string | null
  field_key: string
  original_name: string
  storage_path: string
  mime_type: string
  size_bytes: number
  sha256: string
  uploaded_by: string
  created_at: Timestamp
}

export interface SubjectEventTable {
  id: string
  study_id: string
  site_name: string
  subject_id: string
  record_id: string | null
  event_type: string
  occurred_on: string
  title: string
  details: string | null
  before_status: string | null
  after_status: string | null
  created_by: string
  created_at: Timestamp
}

export interface ExportJobTable {
  id: string
  study_id: string
  site_name: string | null
  dataset: 'subjects' | 'clinical_data' | 'events' | 'audit'
  format: 'csv' | 'xlsx'
  status: 'queued' | 'running' | 'completed' | 'failed'
  parameters_json: string
  file_path: string | null
  row_count: number | null
  error_message: string | null
  requested_by: string
  created_at: Timestamp
  started_at: string | null
  completed_at: string | null
}

export interface DatabaseSchema {
  users: UserTable
  sessions: SessionTable
  studies: StudyTable
  sites: SiteTable
  study_memberships: MembershipTable
  membership_sites: MembershipSiteTable
  roles: RoleTable
  permissions: PermissionTable
  role_permissions: RolePermissionTable
  membership_permission_overrides: MembershipPermissionOverrideTable
  audit_events: AuditEventTable
  visit_definitions: VisitDefinitionTable
  uploaded_files: UploadedFileTable
  subject_events: SubjectEventTable
  export_jobs: ExportJobTable
}
