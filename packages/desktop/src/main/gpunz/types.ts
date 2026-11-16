/**
 * gpu.nz Code: what the main process and the renderer say to each other about the rented model.
 * The shapes of the gpu.nz API objects are in docs/api/CONTRACT.md of the gpu.nz repository.
 */

export type Money = { kop: number; currency: "RUB" | "USD" }

export type GpunzAccount = {
  email: string | null
  balanceKop: number
  availableKop: number
  burnKopH: number
  currency: "RUB" | "USD"
}

/** One model the app can launch: a ready template of the service. */
export type GpunzModel = {
  /** our id of the model: the template's slug for a ready one, "custom" for the person's own */
  id: string
  /** the template of the service that runs it */
  template: string
  /** the person named the model themselves (an Ollama tag or a Hugging Face GGUF) */
  custom?: boolean
  name: string
  description: string
  /** the model the server pulls, e.g. qwen3.8:27b */
  model: string
  uncensored: boolean
  /** we ran the agent's tool calls against it ourselves */
  verified: boolean
  minVramGb: number
}

export type PickMode = "balanced" | "fast" | "cheap"

/** What a launch would get right now (GET /offers/pick). */
export type GpunzEstimate = {
  modelId: string
  mode: PickMode
  available: boolean
  gpuName: string | null
  gpuSlug: string | null
  country: string | null
  verifiedHost: boolean
  vramGb: number | null
  priceKopH: number
  launchTrafficKop: number
  tokensPerSecond: number | null
  contextTokens: number | null
  launchMinutes: { low: number; high: number } | null
  /** rubles per dollar when the account is in dollars; prices above are market rubles */
  usdRub: number | null
  /** the person's own model: its size and the smallest card it needs */
  sizeGb?: number | null
  minVramGb?: number | null
  /** why there is no estimate: the registry has no such model, or it fits no card we rent */
  problem?: "unknown_model" | "too_big" | "invalid_name" | null
}

export type LaunchStage = { id: string; state: "done" | "active" | "todo"; percent: number }

export type GpunzSession =
  /** nothing rented */
  | { phase: "idle"; lastError?: SessionError }
  /** a server is being picked, created or booted; `attempt` grows when a host failed and another was taken */
  | {
      phase: "launching"
      modelId: string
      modelName: string
      attempt: number
      instanceId: string | null
      gpuName: string | null
      priceKopH: number | null
      currency: "RUB" | "USD"
      percent: number
      stage: string
      stages: LaunchStage[]
      etaMinutes: number | null
      etaKind: string
      usualMinutes: { low: number; high: number } | null
      elapsedSeconds: number
      /** what the user sees under the bar when something happened («the host failed, taking another one») */
      note: SessionNote | null
    }
  /** the model answers; the agent talks to it through the local bridge */
  | {
      phase: "ready"
      modelId: string
      modelName: string
      model: string
      instanceId: string
      gpuName: string
      country: string | null
      priceKopH: number
      currency: "RUB" | "USD"
      contextTokens: number
      startedAt: number
      /** tokens per second of the last answer, measured at the bridge */
      tokensPerSecond: number | null
      idleStopMinutes: number | null
      /** epoch ms when the server is deleted unless used; null without the rule */
      idleStopAt: number | null
      /** the server went away mid-work and another one is being started */
      recovering: boolean
      /** the person's own model answered a trial tool call (null: not checked — a model we tested ourselves) */
      toolsOk: boolean | null
    }
  | { phase: "stopping"; instanceId: string }

export type SessionNote =
  | { kind: "host_failed"; attempt: number }
  | { kind: "host_lost" }
  | { kind: "slow" }

export type SessionError =
  | { kind: "insufficient_funds"; needKop: number | null; currency: "RUB" | "USD" }
  | { kind: "email_not_verified" }
  | { kind: "no_servers" }
  | { kind: "hosts_failed"; attempts: number }
  | { kind: "balance_zero" }
  | { kind: "idle_stopped"; minutes: number | null }
  | { kind: "stopped_elsewhere" }
  | { kind: "network"; message: string }
  | { kind: "auth" }
  | { kind: "unknown"; message: string }

export type GpunzState = {
  signedIn: boolean
  account: GpunzAccount | null
  session: GpunzSession
  /** a device login in progress: the code to confirm in the browser */
  login: { userCode: string; url: string; expiresAt: number } | null
  settings: GpunzSettings
  app: GpunzAppInfo
}

/** The program itself: its version and how it gets a newer one. */
export type GpunzAppInfo = {
  version: string
  /** installs its own updates (our installer on Windows and Linux) */
  selfUpdating: boolean
  /** installed from the Microsoft Store: the Store updates it */
  fromStore: boolean
  /** a newer release is out and this build cannot install it itself (macOS): the person downloads it from the site */
  newVersion: string | null
}

export type FeedbackKind = "bug" | "idea" | "feedback"
export type FeedbackInput = { kind: FeedbackKind; message: string; email?: string | null; includeLog?: boolean }
export type FeedbackResult = { ok: true; id: string } | { ok: false; reason: "network" | "invalid" }

export type GpunzSettings = {
  idleStopMinutes: number | null
  pickMode: PickMode
  lastModelId: string | null
  /** the person's own models, the latest first */
  customModels: string[]
  /** errors the app catches are sent to its makers, without the account or anything of the project (gpunz/reports.ts) */
  errorReports: boolean
}

export const DEFAULT_SETTINGS: GpunzSettings = {
  idleStopMinutes: 30,
  pickMode: "balanced",
  lastModelId: null,
  customModels: [],
  errorReports: true,
}

export const CUSTOM_MODEL_ID = "custom"
export const CUSTOM_TEMPLATE = "ollama"
