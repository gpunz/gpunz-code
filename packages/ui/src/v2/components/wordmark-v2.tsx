import { type ComponentProps } from "solid-js"

/**
 * gpu.nz Code: the large, quiet wordmark behind an empty session, in place of the upstream one.
 * Same export, props and box (720×129) as before.
 */
export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.16">
        <text
          x="360"
          y="98"
          text-anchor="middle"
          font-family='"Manrope", "Inter", system-ui, sans-serif'
          font-size="112"
          font-weight="800"
          letter-spacing="-5"
          fill="currentColor"
        >
          gpu<tspan fill="#b5f542">.</tspan>nz Code
        </text>
      </g>
    </svg>
  )
}
