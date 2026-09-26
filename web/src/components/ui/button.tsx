import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
        // A 期视觉升级（visual-upgrade-plan.md §3）：主行动点统一结构——
        // 黑外壳 12px 圆角 + 左侧 44×44 信号橙方块图标底座 + 白色 16px/500 标签。
        // 微交互：hover 图标右移 2px（INDUSTRIAL_ICON_CLASSES 的 group-hover）、
        // 按压 scale-98、200ms 过渡（缓动由全站 ease-industrial 覆盖提供）。
        // 图标底座不作为变体内嵌结构，调用方用 INDUSTRIAL_ICON_CLASSES 包一个 lucide 图标。
        industrial:
          "group rounded-[12px] bg-slate-900 font-medium text-white shadow-sm transition-all duration-200 hover:bg-slate-800 active:scale-[0.98] motion-reduce:active:scale-100",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
    compoundVariants: [
      {
        // industrial 外壳自带几何（44px 底座 + 4px 壳内边距 + 20px 标签侧留白），
        // 覆盖 default 尺寸的 h-9/px-4/py-2（compound 类排在 size 类后，twMerge 优先生效）
        variant: "industrial",
        size: "default",
        class: "h-auto gap-3 p-1 pr-5 text-base",
      },
      {
        // 紧凑档（规范 §5 辅助 CTA：图标底座约 36px→此处 28px、图标 14px）：
        // 用于 TopBar 等密集工具行，与 h-8 的 ghost 按钮同一排不跳脱
        variant: "industrial",
        size: "sm",
        class: "h-8 gap-2 rounded-[10px] p-0.5 pr-3 text-sm",
      },
    ],
  }
)

/** industrial variant 的 44×44 信号橙图标底座（白色 20px 图标；hover 随外壳 group-hover 右移 2px） */
export const INDUSTRIAL_ICON_CLASSES =
  "flex size-11 shrink-0 items-center justify-center rounded-[8px] bg-indigo-500 text-[#ffffff] transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"

/** industrial size="sm" 的 28×28 紧凑图标底座（白色 14px 图标；TopBar 工具行用） */
export const INDUSTRIAL_ICON_SM_CLASSES =
  "flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-indigo-500 text-[#ffffff] transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
