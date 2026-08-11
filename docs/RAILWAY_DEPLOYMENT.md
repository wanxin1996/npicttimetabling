# Railway + SQLite 部署清单

## 1. 仓库与服务

1. 在 Railway 建立一个项目和一个服务，连接 GitHub 仓库 `wanxin1996/npicttimetabling`。
2. 服务的 Root Directory 设置为 `/web`；Config as Code 使用 `/web/railway.json`。
3. 首次试用连接 `codex/timetabling-mvp` 分支；确认后再合并到长期生产分支。
4. 不开启多个 Replicas 或 Multi-region。SQLite 持久卷只能由一个应用实例写入。

`web/railway.json` 固定使用 Railpack、`npm run build`、standalone 服务器、`/api/health` 健康检查及失败重启策略。配置文件不保存密码、token 或业务资料。

## 2. 持久卷

1. 在服务上新增一个 Volume，并挂载到 `/data`。
2. Railway 会自动提供 `RAILWAY_VOLUME_MOUNT_PATH=/data`；应用将数据库保存为 `/data/timetabling.db`。
3. 如需使用其他文件名或子目录，可另外设置 `TIMETABLING_DATABASE_PATH`；该路径仍必须位于挂载卷内，不能指向 `/app` 或其他容器临时目录。
4. 启动脚本会在 Railway 环境检查真实卷路径及数据库目录是否存在且可写；即使设置了自定义数据库路径，没有挂载卷或路径逃出卷时服务也会拒绝启动。

不要在 Build Command 或 Pre-deploy Command 中建立或迁移 SQLite。Railway 的卷只在应用启动容器中挂载，构建和 pre-deploy 容器无法访问卷。

## 3. 首次上线

1. 在密码管理器生成至少 32 bytes 的随机一次性值（例如 64 位十六进制），并把它作为 Railway Secret Variable `TIMETABLING_SETUP_TOKEN`；不要写进 Git、构建日志或截图。
2. 部署服务、生成 Railway 公网域名，并确认 `GET /api/health` 返回 `{"status":"ok"}`。production 空库若缺少有效 setup token 会刻意返回 503，必须先修正变量，不能关闭这项保护。
3. 首页应显示首次管理员设置，不应出现示例教师、班级、教室或内置密码。项目负责人输入与 Railway 完全相同的 setup token，建立真实管理员账号。
4. 管理员建立成功后可以删除或轮换 `TIMETABLING_SETUP_TOKEN`；已有管理员的数据库不再依赖该令牌。重新部署并确认 health 仍为 200、管理员仍可正常登录。
5. 导入 Teaching Members Excel，并手工建立真实学生班级与教室；本机开发数据库不会自动上传到公网。
6. 建立第二个 scheduler 账号，用两个浏览器验证 5 秒同步和 revision 冲突提示。

## 4. 备份与恢复

1. 管理员在系统 `Accounts` 页面下载完整 SQLite 备份；系统会在下载前后检查结构和外键，并从副本中清除登录会话。
2. 首次导入、重要排课日结束及每个使用周期结束时各下载一次，把文件保存到有访问权限控制且不属于 Railway 项目的部门位置。
3. 在服务 Backups 页面同时启用 Daily 和 Weekly：Railway 当前分别保留约 6 天和 1 个月；首次导入及重要排课日结束后另行手工触发一次 Volume backup。
4. 系统内恢复只选择本系统下载的 `.sqlite`：上传后完成两次勾选并输入 `RESTORE FULL BACKUP`；成功时全部浏览器会退出，使用备份内管理员重新登录。
5. 每次系统内恢复前会在同一持久卷的 `timetabling-restore-safety/` 保存当前状态安全副本；恢复后核对教师、课程、班次和排课数量及 `GET /api/health`，确认前不要删除该副本。
6. Railway 平台恢复演练也必须在正式交付前完成；平台会建立替代卷并保留原卷但卸载，确认新卷正确前不要删除旧卷。
7. 删除 Volume 会一并删除其平台备份和恢复安全副本，因此系统下载的项目外副本不能省略。

## 5. 发布验收

部署后在 `web/` 目录运行自动验收；该命令不会修改教师、课程、班级、教室或课表资料：

```bash
npm run verify:deployment -- https://你的Railway域名
```

建立验收账号后，可临时通过环境变量增加登录验证。脚本会检查 Secure、HttpOnly、SameSite=Strict Cookie 和认证后的教师 API，并在结束前自动退出该次会话；不要把真实密码写入 Git、文档或终端截图：

```bash
TIMETABLING_SMOKE_USERNAME=验收账号 \
TIMETABLING_SMOKE_PASSWORD=验收密码 \
npm run verify:deployment -- https://你的Railway域名
```

自动脚本只验证 HTTP 健康、安全响应头、公开认证边界，以及可选验收账号的登录／退出。下列项目必须在 Railway 控制台和两个真实浏览器中人工核对，不能把脚本通过当成这些步骤已经完成：

- Railway deployment 状态为 Active，健康检查为 HTTP 200。
- 服务只有一个实例，数据库实际位于挂载卷。
- HTTPS、Secure/HttpOnly/SameSite Cookie 与安全响应头生效。
- 两个账号可跨浏览器看到 5 秒内更新；旧 revision 保存返回 409。
- Daily、Weekly 与一次手工备份均已存在，并成功完成一次恢复演练。
- 临时验收账号和测试排课已清除后，才把网址交给真实团队。
