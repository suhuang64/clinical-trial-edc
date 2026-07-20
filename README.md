# OpenEDC

OpenEDC 1.0.0 是面向多项目、多中心临床研究的轻量级电子数据采集系统（EDC）。系统支持研究项目、研究中心、成员权限、动态表单、受试者筛选与入组、随机化、随访数据录入、文件管理、数据导出、仪表盘和审计日志。

技术栈：Vue 3、Element Plus、Vant、Node.js、Fastify、Kysely 和 SQLite。

## 1. 运行要求

- Node.js 24 或更高版本
- npm 11 或更高版本
- 生产环境需要一个 HTTPS 反向代理（例如 Nginx）
- 生产环境只运行一个 API 进程和一个 SQLite 数据库

项目依赖安装在项目目录中，不需要全局安装 npm 包。

## 2. 环境配置

开发和生产使用同一套数据库与文件目录，只通过两个环境文件区分运行模式：

```text
.env.development
.env.production
```

两个文件的共同内容为：

```text
HOST=127.0.0.1
PORT=3000

DATABASE_PATH=./storage/data/edc.sqlite
UPLOAD_ROOT=./storage/uploads
QUARANTINE_ROOT=./storage/quarantine
EXPORT_ROOT=./storage/exports

SESSION_COOKIE_NAME=edc_session
SESSION_TTL_HOURS=12
```

`.env.development` 另外设置：

```text
NODE_ENV=development
TRUST_PROXY=false
```

`.env.production` 另外设置：

```text
NODE_ENV=production
TRUST_PROXY=true
```

真实 `.env.development` 和 `.env.production` 已被 Git 忽略，不能提交到 GitHub。管理员密码不要写入环境文件；初始化管理员时通过当前命令临时传入 `EDC_ADMIN_PASSWORD`。

## 3. 本地开发

第一次使用时，在项目根目录执行：

```zsh
cd ~/.edc
npm install
mkdir -p storage/data storage/uploads storage/quarantine storage/exports
```

初始化开发管理员：

```zsh
EDC_ADMIN_PASSWORD='至少12位的开发密码' \
  npm run admin:init -- \
  --username admin \
  --name "系统管理员"
```

启动开发环境：

```zsh
npm run dev
```

开发地址：

```text
前端：http://127.0.0.1:5173
API：http://127.0.0.1:3000
```

`npm run dev` 会自动加载 `.env.development`，同时启动 API 和 Vite 开发服务器。停止开发环境按 `Ctrl+C` 即可。

## 4. 生产构建和启动

在项目根目录执行：

```zsh
cd ~/.edc
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
```

首次生产部署时初始化管理员：

```zsh
EDC_ADMIN_PASSWORD='至少12位的生产密码' \
  npm run admin:init -- \
  --username pepper \
  --name "辣椒小皇纸"
```

启动生产 API：

```zsh
npm run start
```

`npm run start` 会自动加载 `.env.production`，API 监听 `127.0.0.1:3000`。健康检查：

```zsh
curl http://127.0.0.1:3000/api/health
```

正常返回：

```json
{ "status": "ok", "time": "2026-07-20T00:00:00.000Z" }
```

## 5. Docker Nginx 部署

生产前端构建文件位于：

```text
apps/web/dist
```

如果 Nginx 运行在 Docker 中，需要把前端目录挂载到容器，例如：

```text
~/.nginx/openedc:/usr/share/nginx/html/openedc:ro
```

Nginx 的 OpenEDC server 至少需要包含：

```nginx
server {
    listen 8011 ssl;
    http2 on;
    server_name edc.peppernotes.top;

    ssl_certificate /etc/letsencrypt/live/peppernotes.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/peppernotes.top/privkey.pem;

    root /usr/share/nginx/html/openedc;
    index index.html;
    client_max_body_size 25m;

    location /api/ {
        proxy_pass http://host.docker.internal:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host $host;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

如果 Nginx 容器只暴露宿主机的 8011 端口，用户通过以下地址访问：

```text
https://edc.peppernotes.top:8011/
```

每次发布新前端版本后：

```zsh
npm run build
rsync -a --delete apps/web/dist/ ~/.nginx/openedc/
docker exec nginx nginx -t
docker exec nginx nginx -s reload
```

不要把 3000 端口暴露到公网。Docker Nginx 通过 `host.docker.internal:3000` 访问 Mac 主机上的 API。

## 6. OpenEDC 使用教程

### 6.1 登录和个人设置

使用超级管理员账号登录后，先进入“设置”：

1. 完善姓名、性别、出生日期、手机、邮箱和单位。
2. 选择界面语言和浅色/深色主题。
3. 如需更换密码，在“账号安全”中修改。

### 6.2 创建研究项目

进入“研究项目”：

1. 点击新建研究项目。
2. 填写项目名称、方案编号、申办方、研究类型和起止日期。
3. 保存后进入该研究。

超级管理员可以在研究项目编辑弹窗中删除项目。删除项目会同时删除该项目的中心、成员、表单、受试者、记录、随机化、导出和审计等关联数据，生产环境执行前必须确认备份。

### 6.3 创建研究中心

进入“中心管理”：

1. 新建研究中心。
2. 填写中心名称、主要研究者、联系人和入组目标。
3. 中心编号由系统内部管理，页面主要显示中心名称。

项目管理员可以管理项目中心；中心管理员和研究者只能访问自己所属中心的数据。

### 6.4 创建成员并分配权限

进入“成员与权限”：

1. 搜索已经注册的平台账号。
2. 按姓名选择目标用户；同名用户会同时显示单位等信息用于鉴别。
3. 将用户加入当前研究并分配中心。
4. 选择角色模板：项目管理员、中心管理员、研究者或观察者。
5. 如有需要，再对单个用户增加或撤销细粒度权限。

平台账号由用户注册或超级管理员创建；研究项目内只分配已有账号。一个用户在同一个研究中只能属于一个中心。

### 6.5 设计筛选表单

进入“表单设计”：

1. 新建一份筛选表单。
2. 添加字段组和字段，例如性别、年龄、疾病分区等。
3. 设置字段类型、必填规则、选项和校验规则。
4. 对需要用于随机化分层的字段，开启“纳入随机化”。
5. 保存草稿并预览。
6. 确认无误后发布表单。

筛选表单只能设计一份。设置为筛选表单后不能改成其他类型，也不能删除；筛选表单不允许重复录入和绑定访视时间点。

### 6.6 配置访视计划和随访表单

进入“访视计划”创建研究访视时间点，然后在“表单设计”中创建基线或随访表单：

1. 选择表单用途。
2. 绑定适用访视时间点。
3. 配置字段、校验、条件显示和重复录入规则。
4. 发布表单后，在受试者详情页进行数据录入。

已经存在数据记录的表单不能直接删除；发布版本也不能就地修改，需要通过新版本和迁移流程演进。

### 6.7 配置随机化

进入“随机化”：

1. 添加治疗组并设置比例；治疗组不能为空。
2. 选择随机化方法和区组大小。
3. 在“分层/平衡因素”中选择筛选表单里已经标记为随机化变量的字段。
4. 运行模拟，查看总体、各中心、各治疗组以及每个分层变量的分布。
5. 确认方案后启用。
6. 完成首例随机化后，治疗组、比例、方法、种子和分层设置会冻结。

项目管理员或统计管理员负责查看和配置随机化方案；研究者和中心管理员只能执行随机化，不能查看完整种子、区组大小和算法细节。

### 6.8 创建和管理受试者

进入“受试者”：

1. 点击“新建筛选”。
2. 选择中心并填写筛选表单。
3. 保存筛选记录并完成筛选结论。
4. 对符合条件的受试者办理入组。
5. 在已启用随机化方案的研究中执行随机化。
6. 在列表和受试者详情页查看随机号、随机分组和完成情况。

受试者详情页可以进行随访、表单数据录入、文件上传、事件记录和时间线查看。

### 6.9 查看仪表盘、导出和审计

- “项目仪表盘”：查看入组、随机化、完成情况、中心分布和最近活动。
- “数据导出”：按权限导出 CSV 或 Excel。
- “审计日志”：按人员、动作、对象、中心和时间筛选所有关键操作。
- “设置”：修改个人信息、主题、语言和账号安全设置。

观察者只能查看自己所属中心的数据，不能新建筛选、随机化、录入或导出数据。

## 7. 数据和备份注意事项

OpenEDC 使用单实例 SQLite：

- 不要同时启动两个指向同一个数据库的 API 进程。
- 数据库、WAL 文件和上传目录必须作为同一时间点备份。
- 不要在运行中直接复制单个 `.sqlite` 文件作为一致性备份。
- 不要把数据库、上传文件、导出文件和环境文件提交到 GitHub。
- 生产升级前先停止 API 并备份 `storage/data`、`storage/uploads` 和 `storage/quarantine`。

## 8. 质量门禁

发布前执行：

```zsh
npm run format:check
npm run typecheck
npm run lint
npm run test
npm run build
```

界面验收应覆盖登录、项目、中心、表单、受试者、随机化、数据录入、导出和审计流程，并检查桌面、平板、手机、中文/英文和浅色/深色主题。

## 9. 表单文件格式说明

表单 JSON/Excel 使用固定格式标识：

```text
openedc-form
```

该标识用于导入文件格式校验，不应手动修改。
