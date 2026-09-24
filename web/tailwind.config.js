/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // v20 暗色主题：业务组件硬编码的色板改为 CSS 变量驱动（亮/暗双主题值见 index.css
        // :root / .dark 的 --c-* 变量表）。仅覆盖实际用到的色阶，未列色阶保持默认。
        // <alpha-value> 保留 bg-white/85 这类透明度修饰。
        // A 期视觉升级：indigo 变量值已整体替换为信号橙 ramp（锚 #F64302）、slate 迁移为
        // 暖灰/灰紫——类名不动，indigo 类名读作「强调色」语义。
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
      fontFamily: {
        // B 期字体层：mono = JetBrains Mono 可变（自托管 woff2，@font-face 见 index.css），
        // 覆盖 Tailwind 默认 mono 栈——既有 font-mono 挂载点（成员/产品 ID 等）自动生效。
        // 栈内显式 CJK 回退：JetBrains Mono 无中文字形，中文自然落回系统黑体（不拉字距）。
        mono: [
          "'JetBrains Mono'",
          'ui-monospace',
          "'SF Mono'",
          'Menlo',
          "'PingFang SC'",
          "'Microsoft YaHei'",
          'system-ui',
          'monospace',
        ],
        // dot = Handjet 点阵可变（颗粒定帧 font-variation-settings 见 index.css .font-dot）。
        // 纪律：只给大数字与拉丁短编号（TopBar 统计、ImportResult 报告数）；中文绝不入点阵。
        dot: [
          'Handjet',
          "'JetBrains Mono'",
          "'PingFang SC'",
          "'Microsoft YaHei'",
          'system-ui',
          'monospace',
        ],
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
      // A 期动效令牌：缓动统一 ease-industrial（快速启动、缓慢落定，见 index.css
      // --ease-industrial 与全站 transition-* 默认缓动覆盖）；时长约定三档——
      // 150ms press（按压）/ 200ms micro（hover、图标、底色）/ 250ms surface（弹窗、浮层）。
      transitionTimingFunction: {
        industrial: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      transitionDuration: {
        // surface 档（150/200 为 Tailwind 默认档，250 为补充档）
        250: "250ms",
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