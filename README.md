# OpenEDC

面向多项目、多中心临床研究的轻量 EDC。前端使用 Vue 3、Element Plus 与 Vant，后端使用 Node.js、Fastify、Kysely 和 SQLite。

## 本地开发

要求 Node.js 24+、npm 11+。

```zsh
npm install
export EDC_ADMIN_PASSWORD='请替换为至少 12 个字符的管理员密码'
npm run admin:init -- --username admin --name "系统管理员"
npm run dev
```

初始化管理员前需在当前终端设置 `EDC_ADMIN_PASSWORD`，密码至少 12 个字符。开发地址为 `http://127.0.0.1:5173`，API 为 `http://127.0.0.1:3000`。

## 生产构建与启动

```zsh
npm ci
npm run build
npm run start
```

### 生产边界

当前版本为单台云服务器、单个 API 进程和单个 SQLite 数据库。

前端静态文件位于 `apps/web/dist`，API 监听 `HOST:PORT`。

反向代理应让浏览器通过同一站点访问前端与 `/api`；生产环境启用 Secure 会话 Cookie，因此上游必须提供 HTTPS。

不要同时启动两个指向同一 `DATABASE_PATH` 的 API 进程，也不要把 SQLite 文件放在 SMB/NFS 等网络共享目录。

Nginx/HTTPS、定时清理和系统级备份由部署者管理，不属于应用内功能。

### 生产环境变量

以 `.env.example` 为模板，通过进程管理器注入生产值，不要把密钥提交到 Git：

```text
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
DATABASE_PATH=/srv/edc-data/edc.sqlite
UPLOAD_ROOT=/srv/edc-data/uploads
QUARANTINE_ROOT=/srv/edc-data/quarantine
EXPORT_ROOT=/srv/edc-data/exports
SESSION_COOKIE_NAME=edc_session
SESSION_TTL_HOURS=12
TRUST_PROXY=true
```

- `TRUST_PROXY=true` 只应在 API 位于可信反向代理之后时使用。
- `HOST` 推荐保持回环地址，只由本机反向代理访问。
- 所有数据路径应使用持久盘绝对路径；相对路径会相对于项目根目录解析。
- `DATABASE_PATH`、`UPLOAD_ROOT`、`QUARANTINE_ROOT` 和 `EXPORT_ROOT` 应放在受保护的数据卷中，并只授予运行 EDC 的系统账号读写权限。
- 不得把数据库、上传目录、导出目录或 `.env` 提交到 Git；运行账号不应拥有项目源码之外的额外系统权限。

### 首次部署

1. 在发布目录运行 `npm ci` 和 `npm run build`。
2. 创建数据目录并设置最小文件权限，注入生产环境变量。
3. 设置仅用于当前命令的 `EDC_ADMIN_PASSWORD`，运行：

   ```sh
   npm run admin:init -- --username <用户名> --name "<显示名>"
   ```

   密码至少 12 个字符。初始化命令会创建数据库、初始化当前版本 schema 并创建唯一的新超级管理员；已有同名账号时拒绝覆盖。

4. 运行 `npm run start`，请求 `GET /api/health` 确认返回 `status: ok`。
5. 通过 HTTPS 登录，确认管理员账号、语言、主题和当前研究列表。

### SQLite 与后台任务

应用打开数据库时固定启用 `foreign_keys = ON`、`journal_mode = WAL`、`busy_timeout = 5000` 和 `synchronous = NORMAL`。SQLite 只支持单实例单写入宿主机；必须监控磁盘空间、数据库/WAL 大小以及上传和导出目录大小。

表单迁移和数据导出是持久化后台任务。服务正常关闭时会停止接收新请求，并等待已领取任务结束后再关闭数据库。CSV/Excel 生成仍由单实例进程完成，生产数据增长后应在预发布环境按实际字段数压测 Excel 峰值内存。出现长时间写锁或频繁 `SQLITE_BUSY` 时，应检查慢事务、磁盘状态和任务并发，不要通过增加 API 实例扩容。

### 升级、备份与恢复

升级前通知用户进入维护窗口，停止 API，等待迁移/导出任务结束，并确认端口不再监听。将数据库、同目录的 `-wal`/`-shm`、上传目录和隔离目录做同一恢复点备份，记录应用版本、schema 版本、备份时间、路径、清单和哈希。

部署新源码后运行 `npm ci`、`npm run typecheck` 和 `npm run build`，确认数据库符合当前源码的最终 schema，再用生产配置启动。程序只初始化缺失的最新版表，不包含旧版 schema 的兼容迁移；不要让新版本直接连接旧版或被人工修改过的数据库。

应用不提供内置备份按钮。恢复时先停止 API，将故障现场整体移到独立保留目录，再把同一备份集中的数据库和文件目录恢复到新的空目录，校验权限、路径和空间后，使用备份对应版本启动并验证登录、中心数据范围、受试者、随机化、文件下载和审计记录。数据库和上传文件必须恢复到同一时间点。

代码可以回滚，但 schema 不保证向下兼容。回滚必须停止服务并恢复升级前的完整数据库与文件备份，然后启动与备份匹配的旧版本。

### 空库发布验收

验收必须使用独立临时目录，不能指向现有开发或生产数据。配置全新的 `DATABASE_PATH`、`UPLOAD_ROOT`、`QUARANTINE_ROOT`、`EXPORT_ROOT`、`NODE_ENV=production`、回环 `HOST`、独立 `PORT` 和临时管理员密码，并确认目录为空。

按以下顺序验证：

1. 初始化管理员；再次使用同名账号初始化必须被拒绝。
2. 启动 API，确认当前 schema、`/api/health` 和生产会话 Cookie（HttpOnly、SameSite=Lax、HTTPS 下 Secure）。
3. 创建研究、中心、访视、项目管理员和筛选表单，发布 v1。
4. 创建筛选记录，保存动态表单，完成人工判定、入组和随机化模拟/启用/分配。
5. 创建随访表单，录入草稿、提交、修改并查看审计差异；发布兼容的新版本并验证历史数据迁移。
6. 创建重复表单记录，上传、下载和删除文件，确认数据库与磁盘一致。
7. 生成 CSV/Excel 并重新读取；检查仪表盘、时间线和审计日志。
8. 建立第二个研究和中心，验证通过 URL 或对象 ID 不能跨项目、跨中心越权。
9. 在 1920、1440、1024、768、375px 和手机横屏检查无非预期横向滚动，并检查中英文、浅深色、键盘焦点、动态字号、reduced-motion 和 44px 触控目标。
10. 在存在迁移/导出任务时重启服务，确认任务恢复且不重复完成；停止服务进行冷备份，恢复到另一临时目录并重复登录、文件下载、随机化和审计检查。

验收证据应保存在发布记录或对应的 GitHub issue 中；仅有文档步骤而未实际运行不能标记为空库验收完成。

## 质量门禁

```zsh
npm run typecheck
npm run lint
npm run test
npm run build
```

界面与响应式验收使用 ChatGPT 的电脑功能或浏览器功能：启动 `npm run dev` 后，完成登录、核心业务旅程、375/768/1024/1440/1920px 视口、浅深色主题、中英文和键盘操作检查，并保留截图或操作记录作为证据。

发布前请执行以上质量门禁，并完成本 README 中的生产部署和空库验收步骤。
