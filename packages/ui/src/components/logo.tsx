import { type ComponentProps } from "solid-js"
import splashLogo from "../assets/logo.png"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M12 16H4V8H12V16Z" fill="var(--icon-weak-base)" />
      <path data-slot="logo-logo-mark-o" d="M12 4H4V16H12V4ZM16 20H0V0H16V20Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

// PunkcodeAI 启动 splash logo（M-启动慢修复 + 渐变流光）：
//   logo.png（PUNK CODE 朋克编码 wordmark, 深色字形 + 透明背景）若直接 <img> 显示，
//   在深色背景下看不见。改为用 logo.png 作 CSS mask（只取字形 alpha 形状），
//   再用流动的渐变背景填充字形——不依赖位图本身颜色，深/浅背景都醒目，且自带流光动画。
//   - mask-image 用 vite import 的 png URL（inline style，运行时 URL）；mask-size:contain 防拉伸。
//   - 渐变 + background-size 200% + animation(logo-splash-shimmer, 见 app/index.css) = 流光横向流动。
//   - inline animation 覆盖调用方 class 里的 animate-pulse（流光取代脉动）；opacity/尺寸 class 仍生效。
export const Splash = (props: Pick<ComponentProps<"div">, "ref" | "class">) => {
  return (
    <div
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      style={{
        "-webkit-mask-image": `url(${splashLogo})`,
        "mask-image": `url(${splashLogo})`,
        "-webkit-mask-repeat": "no-repeat",
        "mask-repeat": "no-repeat",
        "-webkit-mask-position": "center",
        "mask-position": "center",
        "-webkit-mask-size": "contain",
        "mask-size": "contain",
        "background-image":
          "linear-gradient(110deg, #a855f7 0%, #22d3ee 28%, #f472b6 50%, #22d3ee 72%, #a855f7 100%)",
        "background-size": "200% 100%",
        animation: "logo-splash-shimmer 3s linear infinite",
      }}
    />
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        <path d="M18 30H6V18H18V30Z" fill="var(--icon-weak-base)" />
        <path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" fill="var(--icon-base)" />
        <path d="M48 30H36V18H48V30Z" fill="var(--icon-weak-base)" />
        <path d="M36 30H48V12H36V30ZM54 36H36V42H30V6H54V36Z" fill="var(--icon-base)" />
        <path d="M84 24V30H66V24H84Z" fill="var(--icon-weak-base)" />
        <path d="M84 24H66V30H84V36H60V6H84V24ZM66 18H78V12H66V18Z" fill="var(--icon-base)" />
        <path d="M108 36H96V18H108V36Z" fill="var(--icon-weak-base)" />
        <path d="M108 12H96V36H90V6H108V12ZM114 36H108V12H114V36Z" fill="var(--icon-base)" />
        <path d="M144 30H126V18H144V30Z" fill="var(--icon-weak-base)" />
        <path d="M144 12H126V30H144V36H120V6H144V12Z" fill="var(--icon-strong-base)" />
        <path d="M168 30H156V18H168V30Z" fill="var(--icon-weak-base)" />
        <path d="M168 12H156V30H168V12ZM174 36H150V6H174V36Z" fill="var(--icon-strong-base)" />
        <path d="M198 30H186V18H198V30Z" fill="var(--icon-weak-base)" />
        <path d="M198 12H186V30H198V12ZM204 36H180V6H198V0H204V36Z" fill="var(--icon-strong-base)" />
        <path d="M234 24V30H216V24H234Z" fill="var(--icon-weak-base)" />
        <path d="M216 12V18H228V12H216ZM234 24H216V30H234V36H210V6H234V24Z" fill="var(--icon-strong-base)" />
      </g>
    </svg>
  )
}
