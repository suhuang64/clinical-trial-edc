import type Database from 'better-sqlite3'

const initialSchema = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_system_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_system_admin IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'locked')),
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK (locale IN ('zh-CN', 'en-US')),
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS studies (
  id TEXT PRIMARY KEY,
  protocol_code TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  sponsor TEXT,
  study_type TEXT,
  phase TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'ended', 'archived')),
  start_date TEXT,
  end_date TEXT,
  default_locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK (default_locale IN ('zh-CN', 'en-US')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  code TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  principal_investigator TEXT,
  enrollment_target INTEGER NOT NULL DEFAULT 0 CHECK (enrollment_target >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (study_id, code)
);
CREATE INDEX IF NOT EXISTS idx_sites_study ON sites(study_id);

CREATE TABLE IF NOT EXISTS roles (
  code TEXT PRIMARY KEY,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  code TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_code TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE IF NOT EXISTS study_memberships (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_code TEXT NOT NULL REFERENCES roles(code),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (study_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON study_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_study ON study_memberships(study_id);

CREATE TABLE IF NOT EXISTS membership_sites (
  membership_id TEXT NOT NULL REFERENCES study_memberships(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  PRIMARY KEY (membership_id, site_id)
);

CREATE TABLE IF NOT EXISTS membership_permission_overrides (
  membership_id TEXT NOT NULL REFERENCES study_memberships(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  PRIMARY KEY (membership_id, permission_code)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  study_id TEXT REFERENCES studies(id) ON DELETE SET NULL,
  site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
  object_type TEXT NOT NULL,
  object_id TEXT,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_study_created ON audit_events(study_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_object ON audit_events(object_type, object_id);
`

const clinicalSchema = `
CREATE TABLE IF NOT EXISTS forms (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  code TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  form_type TEXT NOT NULL,
  repeatable INTEGER NOT NULL DEFAULT 0 CHECK (repeatable IN (0, 1)),
  bind_visits INTEGER NOT NULL DEFAULT 0 CHECK (bind_visits IN (0, 1)),
  active_version_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (study_id, code)
);
CREATE INDEX IF NOT EXISTS idx_forms_study ON forms(study_id);

CREATE TABLE IF NOT EXISTS form_versions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'migrating', 'published', 'failed')),
  schema_json TEXT NOT NULL,
  schema_checksum TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (form_id, version_number)
);

CREATE TABLE IF NOT EXISTS visit_definitions (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (study_id, code)
);

CREATE TABLE IF NOT EXISTS form_visit_bindings (
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  visit_id TEXT NOT NULL REFERENCES visit_definitions(id) ON DELETE CASCADE,
  PRIMARY KEY (form_id, visit_id)
);

CREATE TABLE IF NOT EXISTS study_counters (
  study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  counter_type TEXT NOT NULL CHECK (counter_type IN ('screening', 'subject', 'randomization')),
  current_value INTEGER NOT NULL DEFAULT 0,
  prefix TEXT NOT NULL,
  pad_length INTEGER NOT NULL DEFAULT 4 CHECK (pad_length BETWEEN 1 AND 12),
  PRIMARY KEY (study_id, counter_type)
);

CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id),
  screening_number TEXT NOT NULL,
  subject_number TEXT,
  random_number TEXT,
  status TEXT NOT NULL DEFAULT 'screening' CHECK (status IN ('screening', 'screen_failed', 'pending_enrollment', 'enrolled', 'completed', 'withdrawn', 'lost_to_followup')),
  screening_data_json TEXT NOT NULL DEFAULT '{}',
  screening_conclusion TEXT,
  screening_failure_reason TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (study_id, screening_number),
  UNIQUE (study_id, subject_number),
  UNIQUE (study_id, random_number)
);
CREATE INDEX IF NOT EXISTS idx_subjects_study_site ON subjects(study_id, site_id);
CREATE INDEX IF NOT EXISTS idx_subjects_status ON subjects(study_id, status);

CREATE TABLE IF NOT EXISTS data_records (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id),
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  form_id TEXT NOT NULL REFERENCES forms(id),
  form_version_id TEXT NOT NULL REFERENCES form_versions(id),
  visit_id TEXT REFERENCES visit_definitions(id),
  repeat_index INTEGER NOT NULL DEFAULT 1 CHECK (repeat_index > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  row_version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (subject_id, form_id, visit_id, repeat_index)
);

CREATE TABLE IF NOT EXISTS data_values (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES data_records(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value_text TEXT,
  value_number REAL,
  value_date TEXT,
  value_datetime TEXT,
  value_boolean INTEGER CHECK (value_boolean IN (0, 1)),
  value_json TEXT,
  UNIQUE (record_id, field_key)
);
CREATE INDEX IF NOT EXISTS idx_data_values_field ON data_values(field_key);

CREATE TABLE IF NOT EXISTS randomization_schemes (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE UNIQUE,
  name TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('simple', 'permuted_block', 'stratified_block', 'minimization')),
  arms_json TEXT NOT NULL,
  config_json TEXT NOT NULL,
  seed TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'frozen', 'disabled')),
  sequence_position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  activated_at TEXT,
  frozen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS randomization_assignments (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id),
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT UNIQUE,
  scheme_id TEXT NOT NULL REFERENCES randomization_schemes(id) ON DELETE RESTRICT,
  sequence_position INTEGER NOT NULL,
  arm_id TEXT NOT NULL,
  stratum_key TEXT,
  factors_json TEXT NOT NULL DEFAULT '{}',
  decision_json TEXT NOT NULL,
  assigned_by TEXT NOT NULL REFERENCES users(id),
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (scheme_id, sequence_position)
);
CREATE INDEX IF NOT EXISTS idx_assignments_study_arm ON randomization_assignments(study_id, arm_id);

CREATE TABLE IF NOT EXISTS randomization_strata_state (
  scheme_id TEXT NOT NULL REFERENCES randomization_schemes(id) ON DELETE CASCADE,
  stratum_key TEXT NOT NULL,
  block_index INTEGER NOT NULL DEFAULT 0,
  current_block_json TEXT NOT NULL DEFAULT '[]',
  block_offset INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scheme_id, stratum_key)
);
`

const formMigrationSchema = `
CREATE TABLE IF NOT EXISTS form_migration_jobs (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  from_version_id TEXT REFERENCES form_versions(id),
  to_version_id TEXT NOT NULL REFERENCES form_versions(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  total_records INTEGER NOT NULL DEFAULT 0,
  processed_records INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_form_migration_jobs_form ON form_migration_jobs(form_id, created_at DESC);

CREATE TABLE IF NOT EXISTS form_migration_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES form_migration_jobs(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES data_records(id) ON DELETE CASCADE,
  from_version_id TEXT NOT NULL REFERENCES form_versions(id),
  to_version_id TEXT NOT NULL REFERENCES form_versions(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  error_message TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, record_id)
);
`

const roles = [
  ['study_admin', '研究项目管理员', 'Study administrator'],
  ['site_admin', '中心管理员', 'Site administrator'],
  ['investigator', '研究医生/研究护士', 'Investigator'],
  ['readonly', '只读用户', 'Read-only user'],
] as const

const permissions = [
  ['study.view', 'study', '查看项目', 'View study'],
  ['study.manage', 'study', '管理项目', 'Manage study'],
  ['site.view', 'site', '查看中心', 'View sites'],
  ['site.manage', 'site', '管理中心', 'Manage sites'],
  ['member.view', 'member', '查看成员', 'View members'],
  ['member.manage', 'member', '管理成员与权限', 'Manage members'],
  ['form.view', 'form', '查看表单', 'View forms'],
  ['form.manage', 'form', '管理表单', 'Manage forms'],
  ['form.publish', 'form', '发布表单', 'Publish forms'],
  ['form.import', 'form', '导入表单', 'Import forms'],
  ['form.export', 'form', '导出表单', 'Export forms'],
  ['subject.view', 'subject', '查看受试者', 'View subjects'],
  ['subject.create', 'subject', '创建受试者', 'Create subjects'],
  ['subject.edit', 'subject', '编辑受试者', 'Edit subjects'],
  ['subject.delete', 'subject', '删除受试者', 'Delete subjects'],
  ['subject.enroll', 'subject', '办理入组', 'Enroll subjects'],
  ['randomization.view', 'randomization', '查看随机化', 'View randomization'],
  ['randomization.manage', 'randomization', '配置随机化', 'Manage randomization'],
  ['randomization.execute', 'randomization', '执行随机化', 'Execute randomization'],
  ['data.view', 'data', '查看临床数据', 'View clinical data'],
  ['data.create', 'data', '新增临床数据', 'Create clinical data'],
  ['data.edit', 'data', '修改临床数据', 'Edit clinical data'],
  ['data.delete', 'data', '删除临床数据', 'Delete clinical data'],
  ['file.upload', 'file', '上传文件', 'Upload files'],
  ['file.download', 'file', '下载文件', 'Download files'],
  ['file.delete', 'file', '删除文件', 'Delete files'],
  ['export.execute', 'export', '导出数据', 'Export data'],
  ['audit.view', 'audit', '查看审计日志', 'View audit trail'],
  ['audit.export', 'audit', '导出审计日志', 'Export audit trail'],
  ['dashboard.view', 'dashboard', '查看仪表盘', 'View dashboard'],
] as const

export function runMigrations(sqlite: Database.Database) {
  const version = sqlite.pragma('user_version', { simple: true }) as number
  if (version < 1) {
    sqlite.transaction(() => {
      sqlite.exec(initialSchema)
      const roleStatement = sqlite.prepare(
        'INSERT OR IGNORE INTO roles (code, name_zh, name_en) VALUES (?, ?, ?)',
      )
      for (const role of roles) roleStatement.run(...role)
      const permissionStatement = sqlite.prepare(
        'INSERT OR IGNORE INTO permissions (code, domain, name_zh, name_en) VALUES (?, ?, ?, ?)',
      )
      for (const permission of permissions) permissionStatement.run(...permission)

      const grant = sqlite.prepare(
        'INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES (?, ?)',
      )
      const allCodes = permissions.map(([code]) => code)
      for (const code of allCodes) grant.run('study_admin', code)
      for (const code of allCodes.filter(
        (code) =>
          ![
            'study.manage',
            'form.publish',
            'randomization.manage',
            'audit.view',
            'audit.export',
          ].includes(code),
      ))
        grant.run('site_admin', code)
      for (const code of [
        'study.view',
        'site.view',
        'form.view',
        'subject.view',
        'subject.create',
        'subject.edit',
        'subject.enroll',
        'randomization.view',
        'randomization.execute',
        'data.view',
        'data.create',
        'data.edit',
        'file.upload',
        'file.download',
        'dashboard.view',
      ])
        grant.run('investigator', code)
      for (const code of [
        'study.view',
        'site.view',
        'form.view',
        'subject.view',
        'randomization.view',
        'data.view',
        'file.download',
        'dashboard.view',
      ])
        grant.run('readonly', code)

      sqlite.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run()
      sqlite.pragma('user_version = 1')
    })()
  }
  if (version < 2) {
    sqlite.transaction(() => {
      sqlite.exec(clinicalSchema)
      sqlite.prepare('INSERT INTO schema_migrations (version) VALUES (2)').run()
      sqlite.pragma('user_version = 2')
    })()
  }
  if (version < 3) {
    sqlite.transaction(() => {
      sqlite.exec(formMigrationSchema)
      sqlite
        .prepare(
          `DELETE FROM role_permissions
           WHERE role_code = 'site_admin'
             AND permission_code IN ('form.manage', 'subject.delete', 'data.delete')`,
        )
        .run()
      sqlite.prepare('INSERT INTO schema_migrations (version) VALUES (3)').run()
      sqlite.pragma('user_version = 3')
    })()
  }
  if (version < 4) {
    sqlite.transaction(() => {
      sqlite.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_data_records_without_visit
        ON data_records(subject_id, form_id, repeat_index)
        WHERE visit_id IS NULL;
      `)
      sqlite.prepare('INSERT INTO schema_migrations (version) VALUES (4)').run()
      sqlite.pragma('user_version = 4')
    })()
  }
  if (version < 5) {
    sqlite.transaction(() => {
      sqlite.exec(`
        ALTER TABLE studies ADD COLUMN notes TEXT;
        ALTER TABLE sites ADD COLUMN contact_name TEXT;
        ALTER TABLE sites ADD COLUMN contact_phone TEXT;
        ALTER TABLE sites ADD COLUMN contact_email TEXT;
      `)
      sqlite.prepare('INSERT INTO schema_migrations (version) VALUES (5)').run()
      sqlite.pragma('user_version = 5')
    })()
  }
  if (version < 6) {
    sqlite.transaction(() => {
      sqlite.exec(`
        CREATE TABLE uploaded_files (
          id TEXT PRIMARY KEY,
          study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
          site_id TEXT NOT NULL REFERENCES sites(id),
          subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
          record_id TEXT REFERENCES data_records(id) ON DELETE SET NULL,
          field_key TEXT NOT NULL,
          original_name TEXT NOT NULL,
          storage_path TEXT NOT NULL UNIQUE,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
          sha256 TEXT NOT NULL,
          uploaded_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_uploaded_files_scope ON uploaded_files(study_id, site_id, subject_id);
        CREATE INDEX idx_uploaded_files_record ON uploaded_files(study_id, record_id, field_key);
      `)
      sqlite.prepare('INSERT INTO schema_migrations (version) VALUES (6)').run()
      sqlite.pragma('user_version = 6')
    })()
  }
  if (version < 7) {
    sqlite.transaction(() => {
      sqlite.exec(`
        CREATE TABLE subject_events (
          id TEXT PRIMARY KEY,
          study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
          site_id TEXT NOT NULL REFERENCES sites(id),
          subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL CHECK (event_type IN (
            'adverse_event', 'concomitant_medication', 'protocol_deviation', 'endpoint',
            'death', 'completed', 'withdrawn', 'lost_to_followup', 'note'
          )),
          occurred_on TEXT NOT NULL,
          title TEXT NOT NULL,
          details TEXT,
          before_status TEXT,
          after_status TEXT,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_subject_events_scope
        ON subject_events(study_id, site_id, subject_id, occurred_on, created_at);
      `)
      sqlite.prepare('INSERT INTO schema_migrations (version) VALUES (7)').run()
      sqlite.pragma('user_version = 7')
    })()
  }
  if (version < 8) {
    sqlite.transaction(() => {
      sqlite.exec(`
        CREATE TABLE export_jobs (
          id TEXT PRIMARY KEY,
          study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
          site_id TEXT REFERENCES sites(id),
          dataset TEXT NOT NULL CHECK (dataset IN ('subjects', 'clinical_data', 'events', 'audit')),
          format TEXT NOT NULL CHECK (format IN ('csv', 'xlsx')),
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
          parameters_json TEXT NOT NULL DEFAULT '{}',
          file_path TEXT,
          row_count INTEGER,
          error_message TEXT,
          requested_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          started_at TEXT,
          completed_at TEXT
        );
        CREATE INDEX idx_export_jobs_scope ON export_jobs(study_id, site_id, created_at DESC);
        INSERT OR IGNORE INTO permissions (code, domain, name_zh, name_en)
        VALUES ('audit.export', 'audit', '导出审计日志', 'Export audit trail');
        INSERT OR IGNORE INTO role_permissions (role_code, permission_code)
        VALUES ('study_admin', 'audit.export');
      `)
      sqlite.prepare('INSERT INTO schema_migrations (version) VALUES (8)').run()
      sqlite.pragma('user_version = 8')
    })()
  }
  if (version < 9) {
    sqlite.transaction(() => {
      sqlite.exec(`
        ALTER TABLE audit_events ADD COLUMN subject_id TEXT;
        CREATE INDEX idx_audit_subject_created
        ON audit_events(study_id, site_id, subject_id, created_at DESC);
      `)
      sqlite.prepare('INSERT INTO schema_migrations (version) VALUES (9)').run()
      sqlite.pragma('user_version = 9')
    })()
  }
  if (version < 10) {
    sqlite.transaction(() => {
      sqlite.exec(`
        INSERT OR IGNORE INTO permissions (code, domain, name_zh, name_en) VALUES
          ('file.upload', 'file', '上传文件', 'Upload files'),
          ('file.download', 'file', '下载文件', 'Download files'),
          ('file.delete', 'file', '删除文件', 'Delete files');
        INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
          ('study_admin', 'file.upload'),
          ('study_admin', 'file.download'),
          ('study_admin', 'file.delete'),
          ('site_admin', 'file.upload'),
          ('site_admin', 'file.download'),
          ('investigator', 'file.upload'),
          ('investigator', 'file.download'),
          ('readonly', 'file.download');
      `)
      sqlite.prepare('INSERT INTO schema_migrations (version) VALUES (10)').run()
      sqlite.pragma('user_version = 10')
    })()
  }
  if (version < 11) {
    sqlite.transaction(() => {
      sqlite.exec(`
        ALTER TABLE form_migration_jobs ADD COLUMN request_id TEXT;
        ALTER TABLE form_migration_jobs ADD COLUMN ip_address TEXT;
        ALTER TABLE form_migration_jobs ADD COLUMN user_agent TEXT;
      `)
      sqlite.prepare('INSERT INTO schema_migrations (version) VALUES (11)').run()
      sqlite.pragma('user_version = 11')
    })()
  }
  if (version < 12) {
    sqlite.transaction(() => {
      sqlite.exec(`
        INSERT OR IGNORE INTO permissions (code, domain, name_zh, name_en) VALUES
          ('form.import', 'form', '导入表单', 'Import forms'),
          ('form.export', 'form', '导出表单', 'Export forms');
        INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
          ('study_admin', 'form.import'),
          ('study_admin', 'form.export'),
          ('site_admin', 'form.import'),
          ('site_admin', 'form.export');
      `)
      sqlite.prepare('INSERT INTO schema_migrations (version) VALUES (12)').run()
      sqlite.pragma('user_version = 12')
    })()
  }
  if (version < 13) {
    sqlite.transaction(() => {
      sqlite.exec(`
        ALTER TABLE subject_events
        ADD COLUMN record_id TEXT REFERENCES data_records(id) ON DELETE SET NULL;
        CREATE INDEX idx_subject_events_record
        ON subject_events(study_id, site_id, subject_id, record_id);
      `)
      sqlite.prepare('INSERT INTO schema_migrations (version) VALUES (13)').run()
      sqlite.pragma('user_version = 13')
    })()
  }
}
