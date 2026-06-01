import type { JSX } from "solid-js"
import { PRODUCT_NAME } from "@/branding"

export function NewSessionDesignView(props: { children: JSX.Element }) {
  return (
    <div data-component="session-new-design" class="relative size-full overflow-hidden bg-v2-background-bg-deep">
      <div class="absolute inset-x-0 top-[25.375%] flex justify-center px-6">
        <div class="w-full max-w-[720px]">
          {/* 品牌脱敏：原来这里是 opencode 像素 wordmark（WordmarkV2），
              换成 PunkcodeAI 文字 logo，复用登录/注册页的 .punkcode-logo 霓虹流光样式。 */}
          <div class="punkcode-logo font-mono text-center text-5xl font-bold tracking-tight select-none">
            {PRODUCT_NAME}
          </div>
          <div class="mt-8">{props.children}</div>
        </div>
      </div>
    </div>
  )
}
