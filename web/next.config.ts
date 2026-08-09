import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  experimental: {
    // The provided Teaching Members workbook is about 16 MB. Authentication runs
    // through proxy.ts, whose default cloned-request limit is 10 MB, so allow enough
    // headroom for this known workbook plus multipart form metadata.
    proxyClientMaxBodySize: "25mb",
  },
};

export default nextConfig;
