import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // 覆盖 eslint-config-next 的默认忽略范围，使项目可以明确管理需要跳过的生成目录。
  globalIgnores([
    // eslint-config-next 默认忽略的目录如下：
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
