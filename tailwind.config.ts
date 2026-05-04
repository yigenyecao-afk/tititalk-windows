import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./pill.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          50:  "#f7f7f8",
          100: "#eeeef0",
          200: "#d8d9dc",
          300: "#b4b6bb",
          400: "#83868d",
          500: "#5a5d65",
          600: "#3f424a",
          700: "#2b2d33",
          800: "#1c1e22",
          900: "#0f1014",
        },
        accent: {
          DEFAULT: "#3b82f6",
          rec:     "#ef4444",
          ok:      "#22c55e",
        },
        // (v0.9 Editorial Chinese) editorial token alias —— 跟 site
        // tailwind.config.ts / Mac DesignTokens.swift 同源。新组件用这套；
        // 旧的 ink/* / accent 留兼容，逐步迁移。
        signal: { 600: "#B82E26", 500: "#D7392E", 400: "#E94B3C", 100: "#FBE9E7" },
        calm:   { 700: "#3F5639", 600: "#5B7553", 500: "#7C9874", 100: "#E0EBD9" },
        paper:  { warm: "#F4ECD8", cool: "#EAE7E0" },
      },
      fontFamily: {
        sans: ['"Microsoft YaHei UI"', '"Segoe UI"', "system-ui", "sans-serif"],
        // (v0.9) 编辑型 display + 等宽 caption，给 hero/印章/电报用
        serif: ['"Noto Serif SC"', '"Source Han Serif SC"', '"STSong"', "serif"],
        mono:  ['"JetBrains Mono"', '"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
