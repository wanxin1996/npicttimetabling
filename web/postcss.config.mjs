// Next 构建通过 PostCSS 调用 Tailwind v4 插件；样式入口仍在 globals.css，
// 此处只声明编译插件，避免再维护一份会与组件类名漂移的主题配置。
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
