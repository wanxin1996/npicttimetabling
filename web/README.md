# Timetabling 排课系统

这是一个面向教学排课人员的全栈 Web 应用。核心工作台支持查看年度总课表、处理待排课程、拖放调课、编辑教师/教室/学生班级，以及检查和处理排课冲突。

## 当前发布状态

当前代码已经具备本地自动回归和静态 UX 门槛，但**还不能宣称正式发布验收完成**：

- `docs/UX_TASK_TEST_RESULTS.json` 仍是五名真实用户测试的空模板；
- Railway 线上环境的部署检查和人工冒烟尚未完成；
- 正式发布前必须完成本文“发布门槛”中的人工与线上步骤。

详细状态见 [MVP_ACCEPTANCE.md](../docs/MVP_ACCEPTANCE.md)。

## 技术与部署选择

- 前端与服务端：Next.js、React、TypeScript；
- 数据库：SQLite（`better-sqlite3`）；
- 推荐部署：**Railway 单实例 + 持久化 Volume**；
- 不推荐直接部署到 Vercel。SQLite 需要稳定、可写的持久化文件系统，多实例或临时文件系统会造成数据分叉或丢失。若未来要使用 Vercel，应先迁移到支持并发多实例的外部数据库。

生产部署步骤见 [RAILWAY_DEPLOYMENT.md](../docs/RAILWAY_DEPLOYMENT.md)，系统边界见 [ARCHITECTURE.md](../docs/ARCHITECTURE.md)。

## 本地运行

需要 Node.js `>=20.9.0` 和 npm。

```bash
cd web
npm ci
npm run dev
```

默认开发数据库是 `web/data/timetabling.db`。它可能包含你正在维护的数据，不应拿它运行清库、恢复或破坏性测试。

如果要做隔离验收，先创建独立数据库：

```bash
node scripts/prepare-local-acceptance.mjs
```

脚本会输出数据库绝对路径。将它设置为 `TIMETABLING_DATABASE_PATH` 后再启动服务，例如：

```bash
TIMETABLING_DATABASE_PATH=/绝对路径/timetabling-acceptance.db npm run dev
```

环境变量示例见 [.env.example](.env.example)。生产模式可使用：

```bash
npm run build
TIMETABLING_DATABASE_PATH=/绝对路径/timetabling.db npm start
```

## 发布门槛

### 1. 自动回归

```bash
npm run test:release
```

这一条命令依次执行：

1. ESLint；
2. Prisma schema 与 SQLite 建表 SQL 检查；
3. UX 工作台源码契约检查；
4. 一次生产构建；
5. API CRUD、跨进程并发和性能验收。

`test:release` 不会因为五人结果仍为空而让日常自动回归全部失败，也不能被当作真实用户测试已经通过。

### 2. 五名真实用户任务测试

严格按 [UX_TASK_TEST.md](../docs/UX_TASK_TEST.md) 执行测试，如实填写 `docs/UX_TASK_TEST_RESULTS.json`，再运行：

```bash
npm run verify:ux-results
```

需要一次性执行自动回归和五人证据时，使用明确的人类发布总门槛：

```bash
npm run test:release:human
```

禁止用模拟参与者、猜测时间或复制数据填满结果文件。

### 3. Railway 线上验收

部署完成后运行：

```bash
npm run verify:deployment -- https://你的域名.up.railway.app
```

然后按 [RAILWAY_DEPLOYMENT.md](../docs/RAILWAY_DEPLOYMENT.md) 完成浏览器人工冒烟和重启后数据持久化检查。只有自动回归、五人任务测试和线上验收全部通过，才可以标记正式发布。

## 数据安全

- 不要提交 `.db`、`.db-wal`、`.db-shm`、备份或真实导入文件；
- 不要让测试脚本连接生产数据库或正在使用的本地数据库；
- 修改、导入和恢复前先生成可恢复备份，并确认备份不在 Git 跟踪范围内；
- SQLite 生产环境保持单实例，数据库和备份目录都必须位于 Railway Volume；
- 日志、截图和问题报告中不要泄露密码、真实个人资料或完整数据库路径；
- 数据结构门槛可单独运行 `npm run db:check`；它不读取正式数据库，也不代替数据备份、记录核对和恢复演练。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 启动本地开发服务 |
| `npm run lint` | 运行代码规范检查 |
| `npm run db:check` | 校验 Prisma schema 并生成 SQLite 建表 SQL |
| `npm run verify:ux` | 检查当前 PRD 对应的 UX 源码契约 |
| `npm run verify:ux-results` | 验证五名真实用户结果 |
| `npm run build` | 生成生产构建并准备 standalone 产物 |
| `npm run test:release` | 自动发布回归（不含五人结果） |
| `npm run test:release:human` | 自动回归 + 五人结果总门槛 |
| `npm run verify:deployment -- URL` | 只读验证已部署环境的健康、安全响应头和认证边界；持久卷仍须通过重启与恢复演练人工确认 |

## 目录说明

- `src/app/page.tsx`：工作台页面与主要交互；
- `src/app/api/`：Next.js API 路由；
- `src/lib/`：数据库、并发、校验和排课业务逻辑；
- `scripts/`：数据库准备、自动验收和部署检查；
- `../docs/`：PRD、架构、部署和验收证据。
