import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 生成可独立运行的 Node 服务器目录，供 Railway 等长期运行的托管平台使用。
  // 构建后的整理脚本会把 public 文件和已编译静态资源补入这个部署目录。
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  experimental: {
    // 已知的 Teaching Members 工作簿约为 16 MB。认证请求会经过 proxy.ts，
    // 其克隆请求默认上限是 10 MB，因此这里预留工作簿和 multipart 表单元数据所需空间。
    proxyClientMaxBodySize: "25mb",
  },
  async headers() {
    // 这些响应头提供与托管平台无关的浏览器安全保护。HSTS 在普通 localhost 上会被忽略，
    // 但部署后会要求浏览器继续使用 HTTPS 连接。
    const securityHeaders = [
      { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ];
    return [
      { source: "/:path*", headers: securityHeaders },
      // 时间表和账号响应因用户而异，并可能每几秒发生变化；
      // 共享浏览器缓存或代理服务器绝不能保存这些敏感响应。
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
