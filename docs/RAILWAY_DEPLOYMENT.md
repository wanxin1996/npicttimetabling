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
3. 如需使用其他文件名，可另外设置 `TIMETABLING_DATABASE_PATH`，其优先级高于自动卷路径。
4. 启动脚本会在 Railway 环境检查卷路径是否存在且可写；没有挂载卷时服务会拒绝启动，避免数据落入临时文件系统。

不要在 Build Command 或 Pre-deploy Command 中建立或迁移 SQLite。Railway 的卷只在应用启动容器中挂载，构建和 pre-deploy 容器无法访问卷。

## 3. 首次上线

1. 生成 Railway 公网域名并确认 `GET /api/health` 返回 `{"status":"ok"}`。
2. 首页应显示首次管理员设置，不应出现示例教师、班级、教室或内置密码。
3. 由项目负责人建立真实管理员账号，再导入 Teaching Members Excel。
4. 手工建立真实学生班级与教室；本机开发数据库不会自动上传到公网。
5. 建立第二个 scheduler 账号，用两个浏览器验证 5 秒同步和 revision 冲突提示。

## 4. 备份与恢复

1. 在服务 Backups 页面同时启用 Daily 和 Weekly：Railway 当前分别保留约 6 天和 1 个月。
2. 首次导入及重要排课日结束后手工触发一次 Volume backup。
3. 恢复演练必须在正式交付前完成：记录恢复前的教师、课程、班次和排课数量，恢复一个已知备份，部署 Railway staged changes，再核对数量与 `GET /api/health`。
4. Railway 恢复会建立替代卷并保留原卷但卸载；确认新卷正确前不要删除旧卷。
5. 删除 Volume 会一并删除其备份，因此重要周期结束后仍需保存一份项目外副本。

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

自动脚本覆盖下列基础门槛，其余多人协作和平台备份仍需在 Railway 与两个浏览器中实际操作：

- Railway deployment 状态为 Active，健康检查为 HTTP 200。
- 服务只有一个实例，数据库实际位于挂载卷。
- HTTPS、Secure/HttpOnly/SameSite Cookie 与安全响应头生效。
- 两个账号可跨浏览器看到 5 秒内更新；旧 revision 保存返回 409。
- Daily、Weekly 与一次手工备份均已存在，并成功完成一次恢复演练。
- 临时验收账号和测试排课已清除后，才把网址交给真实团队。
