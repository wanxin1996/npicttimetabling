# 本地保存的 Excel 解析器

`xlsx-0.20.3.tgz` 是从 SheetJS 官方 CDN 下载的 SheetJS Community Edition 0.20.3。
项目把安装包保存在版本库中，部署时不需要临时访问第三方 CDN，也不会因为 npm
公共仓库仍提供旧版本而意外退回存在已知漏洞的 0.18.5。

- 官方下载地址：`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`
- SHA-256：`8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`
- 软件许可证：Apache-2.0（许可证文件也包含在压缩包内）

以后升级时，请从 SheetJS 官方安装文档确认最新修复版本，重新下载安装包，核对版本与
校验值，再同时更新 `package.json`、`package-lock.json`、本文件和开发日志。不要只修改
版本字符串，否则新电脑或部署服务器可能无法重复安装同一份依赖。
