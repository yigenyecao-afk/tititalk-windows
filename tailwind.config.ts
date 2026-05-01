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
      },
      fontFamily: {
        sans: ['"Microsoft YaHei UI"', '"Segoe UI"', "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
