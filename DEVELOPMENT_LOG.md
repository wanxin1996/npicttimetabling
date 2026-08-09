# 开发日志

## 使用规则

- 每次开始开发前先阅读本文件，再检查仓库状态。
- 每完成一个独立、可验证的子任务，即更新本文件并创建一次 Git commit。
- 每条记录说明完成内容、验证方式、相关 commit 和下一步。

## 2026-08-09｜项目基线

### 已完成

- 已确认并归档中文产品需求文档（PRD v1.0）。
- 已创建开发分支 `codex/timetabling-mvp`。
- 已建立本开发日志和基础 `.gitignore`。

### 当前状态

- 尚未初始化应用工程。
- 尚未选定前端、后端、数据库与认证技术栈。
- 现有 `Teaching Members` Excel 的导入格式已在 PRD 中定义。

### 本次验证

- 已检查 Git 工作区和分支状态。

### 下一步

1. 评估并确定适合多人实时协作排课系统的技术栈与基础工程结构。
2. 初始化应用工程，并在完成后独立提交。

## 2026-08-09｜GitHub 远程接入

### 已完成

- 已将 `origin` 配置为 `https://github.com/wanxin1996/npicttimetabling.git`。
- 已完成远程仓库的只读连接检查；当前远程没有分支。
- 已将本地开发分支首次推送至 GitHub。

### 当前状态

- 本地开发分支：`codex/timetabling-mvp`。
- 本地分支已跟踪 `origin/codex/timetabling-mvp`。

### 本次验证

- `git ls-remote --heads origin` 成功完成且未返回远程分支。
- `git push -u origin codex/timetabling-mvp` 成功完成。

### 下一步

1. 评估技术栈并初始化应用工程。

## 2026-08-09｜Web 应用基础工程

### 已完成

- 已在 `web/` 初始化 Next.js 16、React 19、TypeScript、Tailwind CSS 与 ESLint。
- 已移除默认 Google Fonts 依赖，避免构建时依赖外部字体服务。
- 已将生产构建固定为 `next build --webpack`；当前环境的 Turbopack 无法创建其内部所需进程/端口，但 Webpack 构建可稳定通过。

### 技术选择

- 前端与服务层：Next.js App Router + TypeScript。
- UI 样式：Tailwind CSS。
- 质量检查：ESLint 与生产构建。
- 数据库、认证与实时协作将在下一子任务中确定并接入。

### 本次验证

- `npm run lint` 通过。
- `npx next build --webpack` 通过，首页可静态构建。

### 下一步

1. 确定数据库、认证和实时协作方案，并建立数据模型。
2. 实现基础数据维护页面。
