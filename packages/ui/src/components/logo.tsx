import { For, type ComponentProps } from "solid-js"

/**
 * gpu.nz Code: the brand mark of gpu.nz — a 3×3 grid of GPU cores with one running hot — in place of the upstream
 * logo. Same exports and props as before, so every place that draws the logo keeps working.
 */
const CELLS: [number, number][] = [
  [1, 1],
  [9, 1],
  [17, 1],
  [1, 9],
  [17, 9],
  [1, 17],
  [9, 17],
  [17, 17],
]
const HOT = "#b5f542"

function Grid(props: { cold: string }) {
  return (
    <>
      <For each={CELLS}>{([x, y]) => <rect x={x} y={y} width="6" height="6" rx="1.4" fill={props.cold} />}</For>
      <rect x="9" y="9" width="6" height="6" rx="1.4" fill={HOT} />
    </>
  )
}

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <Grid cold="var(--icon-weak-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <Grid cold="var(--icon-base)" />
    </svg>
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
      <g transform="translate(0 6) scale(1.25)">
        <Grid cold="var(--icon-weak-base)" />
      </g>
      <text
        x="42"
        y="31"
        font-family='"Manrope", "Inter", system-ui, sans-serif'
        font-size="29"
        font-weight="700"
        letter-spacing="-0.9"
      >
        <tspan fill="var(--icon-strong-base)">gpu</tspan>
        <tspan fill={HOT}>.</tspan>
        <tspan fill="var(--icon-base)">nz</tspan>
        <tspan fill="var(--icon-weak-base)" font-weight="600" dx="8">
          Code
        </tspan>
      </text>
    </svg>
  )
}
