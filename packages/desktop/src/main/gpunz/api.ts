import { randomUUID } from "node:crypto"

/**
 * The gpu.nz API as the desktop app uses it (https://gpu.nz/api/v1, contract in the service's docs/api/CONTRACT.md).
 * Only the main process talks to it: the account key never reaches the renderer.
 */
const DEFAULT_API = "https://gpu.nz/api/v1"
/**
 * The account key goes only here. An installed build always talks to gpu.nz; the override is for development
 * (a local service), and the only place it is read.
 */
function apiBase(): string {
  const override = process.env.GPUNZ_API_URL
  // `electron .` (a development run) sets defaultApp; an installed build never does
  const development = Boolean((process as { defaultApp?: boolean }).defaultApp)
  return override && development ? override.replace(/\/$/, "") : DEFAULT_API
}
export const API_BASE = apiBase()
export const SITE_URL = API_BASE.replace(/\/api\/v1$/, "")

/** A page of the site (sign-in confirmation, top-up, console): https, our host, nothing else is ever opened. */
export function isSiteUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    const site = new URL(SITE_URL)
    return u.protocol === site.protocol && u.host === site.host && (u.protocol === "https:" || SITE_URL !== "https://gpu.nz")
  } catch {
    return false
  }
}

/**
 * Where a rented model is reached: https on the gateway (run.gpu.nz or a host under it). The address comes from the
 * service together with the server's key, and the key is sent nowhere else.
 */
export function isGatewayUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (SITE_URL !== "https://gpu.nz") return u.protocol === "https:" || u.protocol === "http:" // a development service
    return u.protocol === "https:" && (u.hostname === "run.gpu.nz" || u.hostname.endsWith(".run.gpu.nz"))
  } catch {
    return false
  }
}
/** The public source of the app: where its code, releases and issues live. */
export const REPO_URL = "https://github.com/gpunz/gpunz-code"
export const CLIENT_NAME = "gpu.nz Code"

export class GpunzApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

/** The request never got an answer (offline, DNS, timeout): worth a retry, never a verdict about the account. */
export class GpunzNetworkError extends Error {}

export type ApiInstance = {
  id: string
  name?: string | null
  status: string
  desired_state: string
  gpu: { slug: string; name: string; count: number; vram_gb: number | null }
  template: { slug: string; name: string }
  country: string | null
  currency: "RUB" | "USD"
  price: { running_kop_h: number; stopped_kop_h: number; traffic_kop_gb: number }
  cost_so_far_kop: number
  app?: { ready: boolean; ready_at: string | null }
  llm?: { base_url: string; api_key: string; model: string | null; context_tokens: number | null } | null
  launch?: {
    kind: string
    stage: string
    percent: number
    elapsed_seconds: number
    eta: { kind: string; minutes?: number }
    usual_minutes: { low: number; high: number }
    stages: { id: string; state: "done" | "active" | "todo"; percent: number; seconds: number | null }[]
  } | null
  failure?: { code: string; retry_elsewhere: boolean } | null
  idle_stop?: { minutes: number; at: string } | null
  stop_reason: string | null
  created_at: string
}

export type ApiPick = {
  offer: {
    id: string
    country: string | null
    verified: boolean
    gpu: { slug: string; name: string; vram_gb: number }
  } | null
  estimate: {
    disk_gb: number
    price_kop_h: number
    launch_traffic_kop: number
    tokens_per_second: number | null
    model: string | null
    size_gb?: number | null
    min_vram_gb?: number | null
    context_tokens: number | null
    launch_minutes: { low: number; high: number }
  } | null
  fx?: { usd_rub?: number } | null
}

export type ApiTemplate = {
  slug: string
  name: string
  description: string
  env: Record<string, string>
  min_vram_gb?: number
  public: boolean
}

export type ApiBalance = {
  balance_kop: number
  available_kop: number
  burn_kop_h: number
  runway_hours: number | null
  currency: "RUB" | "USD"
}

type RequestOptions = { key?: string | null; idempotencyKey?: string; timeoutMs?: number; locale?: string }

export async function apiRequest<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "accept-language": options.locale ?? "ru",
    "user-agent": CLIENT_NAME,
  }
  if (options.key) headers.authorization = `Bearer ${options.key}`
  if (body !== undefined) headers["content-type"] = "application/json"
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    })
  } catch (error) {
    throw new GpunzNetworkError(error instanceof Error ? error.message : String(error))
  }
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // an HTML page from the edge (a deploy in progress, a block page): not an answer of the API
    if (!res.ok) throw new GpunzNetworkError(`HTTP ${res.status}`)
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error
    // 5xx and a rate limit are the service being busy, not a verdict
    if (res.status >= 500 || res.status === 429) throw new GpunzNetworkError(err?.message ?? `HTTP ${res.status}`)
    throw new GpunzApiError(res.status, err?.code ?? "error", err?.message ?? `HTTP ${res.status}`, err?.details)
  }
  return data as T
}

export const api = {
  startDeviceLogin: () =>
    apiRequest<{
      device_code: string
      user_code: string
      verification_uri_complete: string
      expires_in: number
      interval: number
    }>("POST", "/auth/device", { client_name: CLIENT_NAME }),
  pollDeviceLogin: (deviceCode: string) =>
    apiRequest<{ api_key: string; key_id: string; user: { email: string | null } }>("POST", "/auth/device/token", {
      device_code: deviceCode,
    }),
  me: (key: string) => apiRequest<{ email?: string | null; user?: { email?: string | null } }>("GET", "/me", undefined, { key }),
  balance: (key: string) => apiRequest<ApiBalance>("GET", "/balance", undefined, { key }),
  templates: () => apiRequest<{ data: ApiTemplate[] }>("GET", "/templates"),
  pick: (template: string, mode: string, gpu?: string | null, model?: string | null) =>
    apiRequest<ApiPick>(
      "GET",
      `/offers/pick?template=${encodeURIComponent(template)}&pick=${encodeURIComponent(mode)}${gpu ? `&gpu=${encodeURIComponent(gpu)}` : ""}${model ? `&model=${encodeURIComponent(model)}` : ""}`,
    ),
  instances: (key: string) => apiRequest<{ data: ApiInstance[] }>("GET", "/instances?status=active&limit=50", undefined, { key }),
  instance: (key: string, id: string) => apiRequest<ApiInstance>("GET", `/instances/${encodeURIComponent(id)}`, undefined, { key }),
  create: (
    key: string,
    input: {
      template: string
      pick: string
      gpu?: string | null
      idleStopMinutes: number | null
      name: string
      /** the person's own model: pulled at first boot, the window sized for the card */
      model?: string | null
    },
    idempotencyKey: string = randomUUID(),
  ) =>
    apiRequest<ApiInstance>(
      "POST",
      "/instances",
      {
        offer_id: "auto",
        template: input.template,
        pick: input.pick,
        ...(input.gpu ? { gpu: input.gpu } : {}),
        ...(input.idleStopMinutes ? { idle_stop_minutes: input.idleStopMinutes } : {}),
        ...(input.model ? { model: input.model, llm_context: "auto" } : {}),
        name: input.name,
      },
      { key, idempotencyKey, timeoutMs: 90_000 },
    ),
  destroy: (key: string, id: string) => apiRequest<ApiInstance>("DELETE", `/instances/${encodeURIComponent(id)}`, undefined, { key }),
  keepalive: (key: string, id: string) =>
    apiRequest<ApiInstance>("POST", `/instances/${encodeURIComponent(id)}/keepalive`, undefined, { key, timeoutMs: 15_000 }),
  setIdleStop: (key: string, id: string, minutes: number | null) =>
    apiRequest<ApiInstance>("PATCH", `/instances/${encodeURIComponent(id)}`, { idle_stop_minutes: minutes }, { key }),
}
