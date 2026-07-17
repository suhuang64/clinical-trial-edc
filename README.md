# 临床试验 EDC

面向多项目、多中心临床研究的轻量 EDC。前端使用 Vue 3、Element Plus 与 Vant，后端使用 Node.js、Fastify、Kysely 和 SQLite。

## macOS 本地开发

要求 Node.js 24+、npm 11+。所有依赖均安装在项目目录，不需要也不允许全局安装。

```zsh
# 不要从 Windows 复制 node_modules；在 macOS 本机安装原生依赖。
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

生产环境、升级、备份恢复、SQLite 单实例与容量要求见 [生产运行手册](docs/PRODUCTION_OPERATIONS.md)。从空库验收的完整步骤见 [空库验收清单](docs/EMPTY_DATABASE_ACCEPTANCE.md)。

## 质量门禁

```zsh
npm run typecheck
npm run lint
npm run test
npm run build
```

界面与响应式验收使用 ChatGPT 的电脑功能或浏览器功能：启动 `npm run dev` 后，完成登录、核心业务旅程、375/768/1024/1440/1920px 视口、浅深色主题、中英文和键盘操作检查，并保留截图或操作记录作为证据。

设计与实现的权威依据为 `DESIGN.md`、`IMPLEMENTATION_PLAN.md` 和 `design-system/clinical-trial-edc/MASTER.md`；完成状态以 `REQUIREMENTS_TRACEABILITY.md` 为准。
