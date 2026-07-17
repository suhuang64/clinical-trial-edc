import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { hashPassword } from '../auth/auth.js'
import { db, closeDatabase } from '../db/database.js'

const { values } = parseArgs({
  options: { username: { type: 'string' }, name: { type: 'string' } },
})
const username = values.username?.trim()
const password = process.env.EDC_ADMIN_PASSWORD

if (!username || !password) {
  console.error(
    '用法：设置 EDC_ADMIN_PASSWORD 环境变量后运行 npm run admin:init -- --username <用户名> [--name <显示名>]',
  )
  process.exitCode = 1
} else if (password.length < 12) {
  console.error('管理员密码至少需要 12 个字符。')
  process.exitCode = 1
} else {
  const existing = await db
    .selectFrom('users')
    .select('id')
    .where('username', '=', username)
    .executeTakeFirst()
  if (existing) {
    console.error(`用户 ${username} 已存在，初始化命令不会覆盖现有账号。`)
    process.exitCode = 1
  } else {
    const id = randomUUID()
    const now = new Date().toISOString()
    await db
      .insertInto('users')
      .values({
        id,
        username,
        display_name: values.name?.trim() || '系统管理员',
        password_hash: await hashPassword(password),
        is_system_admin: 1,
        status: 'active',
        failed_login_count: 0,
        locked_until: null,
        locale: 'zh-CN',
        theme: 'system',
        created_at: now,
        updated_at: now,
      })
      .execute()
    console.log(`系统超级管理员 ${username} 创建成功。`)
  }
}

await closeDatabase()
