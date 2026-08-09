# 公网部署路线决策

## 1. 当前建议

建议首个正式试用环境采用 **Railway 单个 Next.js 服务 + SQLite 持久卷**。

这不是把系统限制在一台老师电脑上。Next.js 服务会运行在公网服务器，所有排课老师仍可从不同地点登录同一个网址；SQLite 文件只是在服务器的持久卷中由同一个应用实例统一读写。

选择这条路线的理由：

- 本系只有少量排课账号，主要在每年两次排课期集中使用，写入并发量低。
- 现有系统的全部业务查询已经由 `better-sqlite3` 完成，保留 SQLite 可以避免立即改写整个数据访问层。
- Railway 官方说明持久卷适合 SQLite，并支持手动以及每日、每周、每月备份；恢复时会先建立替代卷，原卷暂时保留。
- 单实例与当前 5 秒自动同步、课次 revision 防覆盖机制兼容，足以完成首轮真实多人验收。
- 如果以后账号数、并发量或高可用要求明显增加，已经对齐的 Prisma schema 可作为迁移 PostgreSQL 的基础。

官方依据：

- [Railway：部署 Next.js 并从 GitHub 自动部署](https://docs.railway.com/guides/nextjs)
- [Railway：持久卷能力与限制](https://docs.railway.com/volumes/reference)
- [Railway：卷备份明确支持 SQLite](https://docs.railway.com/volumes/backups)

## 2. 路线 A：Railway + SQLite 持久卷（推荐）

### 需要完成的开发工作

1. 为 Next.js 增加 standalone 生产构建和只读健康检查接口。
2. 在 Railway 把仓库根目录设为 `web/`，连接当前 GitHub 分支或合并后的主分支。
3. 为应用挂载 `/data` 持久卷，并设置 `TIMETABLING_DATABASE_PATH=/data/timetabling.db`。
4. 首次部署后导入 Teaching Members，并通过界面建立管理员账号；不把本机测试账号写进代码或镜像。
5. 开启每日和每周卷备份，在上线前实际执行一次恢复演练。
6. 使用两个账号、两个浏览器执行跨地点协作验收，再把网址交给真实排课团队。

### 已知限制

- 挂载卷的服务只能运行一个实例，不能横向增加副本。
- 部署新版本时会有短暂停机；Railway 官方说明卷不能同时挂载到两个部署，以避免数据损坏。
- 卷被彻底删除会同时失去其备份，因此仍应定期把关键备份下载或复制到项目之外。
- “开始新一轮”的应急快照与平台备份用途不同：前者用于误操作恢复，后者用于服务器或文件损坏恢复，两者都要保留。

### 适用期

首轮试用及当前小规模系级排课。出现以下任一情况时，应升级 PostgreSQL：

- 需要多个应用实例或无停机发布。
- 同时编辑人数或数据量显著增加，并出现持续锁等待。
- 学校要求数据库高可用、细粒度审计或更长的时间点恢复。
- 系统扩展到多个系或成为全年高频使用的正式平台。

## 3. 路线 B：托管 PostgreSQL

可选组合包括 Railway Next.js + Railway Postgres，或 Vercel Next.js + Neon/Prisma Postgres。Vercel 官方明确说明其函数文件系统不能永久保存 SQLite，因此选择 Vercel 就必须先迁移外部数据库。

官方依据：

- [Vercel：SQLite 不能作为持久数据库](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel)
- [Prisma：PostgreSQL 与 serverless 连接方式](https://www.prisma.io/docs/orm/core-concepts/supported-databases/postgresql)
- [Prisma Postgres：托管、连接池与备份能力](https://www.prisma.io/docs/postgres)

### 额外开发工作

1. 把 `src/lib/database.ts` 中全部同步 `prepare/get/all/run` 查询改成异步 Prisma 或 PostgreSQL 查询。
2. 把 SQLite 专有的 `PRAGMA`、`INSERT OR IGNORE`、`GROUP_CONCAT`、布尔整数和事务写法替换为 PostgreSQL 等价实现。
3. 建立正式迁移文件和 SQLite → PostgreSQL 数据搬迁脚本。
4. 重新执行所有规则、导入、新周期、账号和并发更新回归。
5. 配置连接池、生产迁移、数据库备份和恢复演练。

这条路线长期扩展性更好，但在当前规模下会增加较大的开发与验证范围，不能把它当作只修改一个连接字符串的小改动。

## 4. 决策

项目负责人只需确认以下一项：

- **接受推荐路线：Railway + SQLite 持久卷**，先完成真实多人试用。
- **直接迁移 PostgreSQL**，接受更长的开发和回归周期。

在平台确认前，不创建云服务、不产生费用，也不上传本机数据库。
