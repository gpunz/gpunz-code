import { createSignal, onCleanup } from "solid-js"
import type { GpunzEstimate, GpunzModel, GpunzState, PickMode } from "../../main/gpunz/types"

/**
 * The renderer's view of gpu.nz Code: the state the main process sends, the catalogue and the picks for it.
 * One instance per window (created at module load): the gate, the overlay and the pill read the same signals.
 */
const [state, setState] = createSignal<GpunzState | null>(null)
const [models, setModels] = createSignal<GpunzModel[] | null>(null)
const [estimates, setEstimates] = createSignal<Record<string, GpunzEstimate | "loading" | "error">>({})

/** the person put the gate aside to use the agent without a model (old sessions, settings) */
export const [gateDismissed, setGateDismissed] = createSignal(false)

let started = false
function start() {
  if (started) return
  started = true
  void window.api.gpunz.getState().then(setState)
  window.api.gpunz.subscribe(setState)
  // «in use» is also a person typing or clicking in the window, not only requests to the model
  let last = 0
  const active = () => {
    const now = Date.now()
    if (now - last < 20_000) return
    last = now
    void window.api.gpunz.activity()
  }
  window.addEventListener("keydown", active, { passive: true })
  window.addEventListener("pointerdown", active, { passive: true })
  // a top-up made in the browser shows up when the person comes back to the window
  window.addEventListener("focus", () => void window.api.gpunz.refresh())
}

export function useGpunz() {
  start()
  return { state, models, estimates }
}

export async function loadModels() {
  const list = await window.api.gpunz.models().catch(() => [] as GpunzModel[])
  setModels(list)
  return list
}

const key = (modelId: string, mode: PickMode, customName?: string | null) =>
  `${modelId}:${customName ?? ""}:${mode}`

/** `customName`: the person's own model, by the name they typed. */
export function estimateOf(modelId: string, mode: PickMode, customName?: string | null) {
  return estimates()[key(modelId, mode, customName)]
}

export async function loadEstimate(modelId: string, mode: PickMode, customName?: string | null, force = false) {
  const k = key(modelId, mode, customName)
  const current = estimates()[k]
  if (!force && current && current !== "error") return
  setEstimates((prev) => ({ ...prev, [k]: "loading" }))
  try {
    const est = await window.api.gpunz.estimate(modelId, mode, customName)
    setEstimates((prev) => ({ ...prev, [k]: est }))
  } catch {
    setEstimates((prev) => ({ ...prev, [k]: "error" }))
  }
}

/** A clock for countdowns: ticks once a second while something on the screen needs it. */
export function useNow(everyMs = 1000) {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), everyMs)
  onCleanup(() => clearInterval(timer))
  return now
}
