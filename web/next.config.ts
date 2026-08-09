import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a self-contained Node server for long-running hosts such as Railway.
  // The post-build script below adds public and compiled static assets to the bundle.
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  experimental: {
    // The provided Teaching Members workbook is about 16 MB. Authentication runs
    // through proxy.ts, whose default cloned-request limit is 10 MB, so allow enough
    // headroom for this known workbook plus multipart form metadata.
    proxyClientMaxBodySize: "25mb",
  },
  async headers() {
    // These headers are platform-independent browser safeguards. HSTS is ignored on
    // plain localhost but instructs deployed browsers to keep using HTTPS.
    const securityHeaders = [
      { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ];
    return [
      { source: "/:path*", headers: securityHeaders },
      // Timetable and account responses are user-specific and can change every few
      // seconds; shared browsers or proxies must never retain them.
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
