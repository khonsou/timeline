/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // v20 暗色主题：业务组件硬编码的色板改为 CSS 变量驱动（亮/暗双主题值见 index.css
        // :root / .dark 的 --c-* 变量表）。仅覆盖实际用到的色阶，未列色阶保持默认。
        // <alpha-value> 保留 bg-white/85 这类透明度修饰；:root 亮色值与 Tailwind 默认完全一致（零回归）。
        white: "rgb(var(--c-white) / <alpha-value>)",
        slate: {
          50: "rgb(var(--c-slate-50) / <alpha-value>)",
          100: "rgb(var(--c-slate-100) / <alpha-value>)",
          200: "rgb(var(--c-slate-200) / <alpha-value>)",
          300: "rgb(var(--c-slate-300) / <alpha-value>)",
          400: "rgb(var(--c-slate-400) / <alpha-value>)",
          500: "rgb(var(--c-slate-500) / <alpha-value>)",
          600: "rgb(var(--c-slate-600) / <alpha-value>)",
          700: "rgb(var(--c-slate-700) / <alpha-value>)",
          800: "rgb(var(--c-slate-800) / <alpha-value>)",
          900: "rgb(var(--c-slate-900) / <alpha-value>)",
        },
        indigo: {
          50: "rgb(var(--c-indigo-50) / <alpha-value>)",
          200: "rgb(var(--c-indigo-200) / <alpha-value>)",
          300: "rgb(var(--c-indigo-300) / <alpha-value>)",
          400: "rgb(var(--c-indigo-400) / <alpha-value>)",
          500: "rgb(var(--c-indigo-500) / <alpha-value>)",
          600: "rgb(var(--c-indigo-600) / <alpha-value>)",
        },
        rose: {
          50: "rgb(var(--c-rose-50) / <alpha-value>)",
          100: "rgb(var(--c-rose-100) / <alpha-value>)",
          200: "rgb(var(--c-rose-200) / <alpha-value>)",
          400: "rgb(var(--c-rose-400) / <alpha-value>)",
          500: "rgb(var(--c-rose-500) / <alpha-value>)",
          600: "rgb(var(--c-rose-600) / <alpha-value>)",
          700: "rgb(var(--c-rose-700) / <alpha-value>)",
        },
        emerald: {
          50: "rgb(var(--c-emerald-50) / <alpha-value>)",
          500: "rgb(var(--c-emerald-500) / <alpha-value>)",
          600: "rgb(var(--c-emerald-600) / <alpha-value>)",
          700: "rgb(var(--c-emerald-700) / <alpha-value>)",
        },
        violet: {
          50: "rgb(var(--c-violet-50) / <alpha-value>)",
          500: "rgb(var(--c-violet-500) / <alpha-value>)",
          700: "rgb(var(--c-violet-700) / <alpha-value>)",
        },
        sky: {
          50: "rgb(var(--c-sky-50) / <alpha-value>)",
          500: "rgb(var(--c-sky-500) / <alpha-value>)",
          700: "rgb(var(--c-sky-700) / <alpha-value>)",
        },
        amber: {
          50: "rgb(var(--c-amber-50) / <alpha-value>)",
          400: "rgb(var(--c-amber-400) / <alpha-value>)",
          500: "rgb(var(--c-amber-500) / <alpha-value>)",
          600: "rgb(var(--c-amber-600) / <alpha-value>)",
          700: "rgb(var(--c-amber-700) / <alpha-value>)",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xs: "calc(var(--radius) - 6px)",
      },
      boxShadow: {
        xs: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "caret-blink": {
          "0%,70%,100%": { opacity: "1" },
          "20%,50%": { opacity: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "caret-blink": "caret-blink 1.25s ease-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}