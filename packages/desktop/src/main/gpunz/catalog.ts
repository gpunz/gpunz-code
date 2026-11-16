import type { ApiTemplate } from "./api"
import { CUSTOM_MODEL_ID, CUSTOM_TEMPLATE, type GpunzModel } from "./types"

/**
 * The models gpu.nz Code offers: ready templates of the service that we ran the agent against ourselves
 * (tool calls in a stream, a real repository task, an MCP tool) — measured 2026-11-12 on RTX 3090/4090/5090.
 * A template that the service no longer lists is dropped from the screen.
 */
export const CATALOG: GpunzModel[] = [
  {
    id: "chat-qwen38",
    template: "chat-qwen38",
    name: "Qwen 3.8 27B",
    description: "",
    model: "qwen3.8:27b",
    uncensored: false,
    verified: true,
    minVramGb: 24,
  },
  {
    id: "chat-qwen38-uncensored",
    template: "chat-qwen38-uncensored",
    name: "Qwen 3.8 27B",
    description: "",
    model: "huihui_ai/Qwen3.8-abliterated:27b",
    uncensored: true,
    verified: true,
    minVramGb: 24,
  },
]

/** The catalogue as the service has it right now: its model names and memory needs win over what was built in. */
export function mergeCatalog(templates: ApiTemplate[] | null): GpunzModel[] {
  if (!templates) return CATALOG
  return CATALOG.flatMap((m) => {
    const t = templates.find((x) => x.slug === m.id)
    if (!t) return []
    return [{ ...m, model: t.env?.OLLAMA_MODEL || m.model, minVramGb: t.min_vram_gb ?? m.minVramGb }]
  })
}

/** A model name as a person may type it: an Ollama tag or a Hugging Face GGUF (the service checks it again). */
export function validModelName(raw: string): string | null {
  const v = raw.trim()
  return /^(hf\.co\/)?[a-z0-9][a-z0-9._-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,95})?(:[A-Za-z0-9._-]{1,64})?$/i.test(v)
    ? v
    : null
}

/** The person's own model as a catalogue entry: the plain template with the model named at launch. */
export function customModel(name: string): GpunzModel {
  const short = name.replace(/^hf\.co\//i, "")
  return {
    id: CUSTOM_MODEL_ID,
    template: CUSTOM_TEMPLATE,
    custom: true,
    name: short.length > 40 ? `${short.slice(0, 39)}…` : short,
    description: "",
    model: name,
    uncensored: false,
    verified: false,
    minVramGb: 0,
  }
}
