import { randomUUID } from "node:crypto"
import { homedir, release } from "node:os"
import { app } from "electron"
import { CHANNEL, FROM_STORE } from "../constants"
import { getStore } from "../store"
import { apiRequest, GpunzApiError, GpunzNetworkError } from "./api"
import { readSettings } from "./vault"

/**
 * What gpu.nz Code tells its makers: errors it caught, and what the person writes in «Помощь и обратная связь».
 *
 * Errors go out by themselves (Settings can turn that off), so they carry nothing of the person: no account, no file
 * contents, no prompts — the error's text and stack with home-folder names, e-mail addresses and keys masked, the
 * app's version, the system, and an install id the app made up. The same error is sent once in six hours and no more
 * than twenty-five reports leave a computer in a day. Development and beta builds send nothing.
 * Feedback is sent only when the person presses «Отправить», with the account (so somebody can answer) and, if they
 * tick the box, the end of the app's log.
 */
export type ReportSource = "main" | "renderer" | "agent" | "native"

type Facts = Record<string, string | number | boolean | null>
type Report = { source: ReportSource; kind: string; message: string; stack: string; context?: Facts }

const STORE = "gpunz.reports"
const REPEAT_MS = 6 * 60 * 60 * 1000
const PER_DAY = 25
const BATCH = 10

let queue: Report[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let retries = 0
let context: () => Facts = () => ({})
let log: (message: string, meta?: Record<string, unknown>) => void = () => undefined
const seen = new Map<string, number>()

/** Whether errors are sent at all: an installed release build, unless the person turned it off. */
export function reportsEnabled(): boolean {
  const env = process.env.GPUNZ_REPORTS
  if (env === "0") return false
  if (!app.isPackaged || CHANNEL !== "prod") return env === "1"
  return readSettings().errorReports
}

/** A random id of this installation: tells «the same computer» apart, says nothing about who uses it. */
export function installId(): string {
  const store = getStore(STORE)
  const current = store.get("install")
  if (typeof current === "string" && /^[0-9a-f-]{36}$/.test(current)) return current
  const next = randomUUID()
  store.set("install", next)
  return next
}

export function appInfo() {
  const system = (process as { getSystemVersion?: () => string }).getSystemVersion?.() ?? release()
  return {
    version: app.getVersion(),
    channel: FROM_STORE ? "store" : app.isPackaged && CHANNEL === "prod" ? "direct" : "dev",
    platform: process.platform,
    os_version: system.slice(0, 60),
    arch: process.arch,
    locale: app.getLocale().slice(0, 16) || null,
  }
}

/** Keys, tokens, e-mail addresses and the name inside home-folder paths never leave the computer. */
export function scrub(text: string, max = 12_000, home = homedir()): string {
  let s = text.length > max ? `${text.slice(0, max)}\n…[${text.length - max} more]` : text
  if (home.length > 3) {
    for (const form of new Set([home, home.replaceAll("\\", "/"), home.replaceAll("\\", "\\\\")])) s = s.replaceAll(form, "~")
  }
  s = s.replace(/\bgnz_[A-Za-z0-9_-]{8,}/g, "gnz_***")
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
  s = s.replace(/([?&](?:token|key|api_key|access_token|password|secret)=)[^&\s"'<>)]+/gi, "$1***")
  s = s.replace(/\b(sk|pk|ghp|gho|glpat|xox[abp])[-_][A-Za-z0-9_-]{12,}/g, "$1-***")
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "***@***")
  s = s.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/:"'<>|\r\n]+/gi, "$1~")
  s = s.replace(/(\/(?:Users|home)\/)[^/\s:"'<>|]+/g, "$1~")
  return s
}

/** Not bugs: the network being away, and browser noise that names no code of ours. */
export function ignorable(message: string): boolean {
  return /net::ERR_|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EPIPE|fetch failed|Failed to fetch|NetworkError|The operation was aborted|AbortError|TimeoutError|ResizeObserver loop|^Script error\.?$/i.test(
    message,
  )
}

export function describeError(error: unknown): { message: string; stack: string } {
  if (error instanceof Error) {
    const name = error.name && error.name !== "Error" ? error.name : "Error"
    return { message: `${name}: ${error.message}`, stack: error.stack ?? "" }
  }
  if (error && typeof error === "object") {
    const e = error as { message?: unknown; stack?: unknown }
    if (typeof e.message === "string") return { message: e.message, stack: typeof e.stack === "string" ? e.stack : "" }
    try {
      return { message: JSON.stringify(error).slice(0, 2_000), stack: "" }
    } catch {
      return { message: String(error), stack: "" }
    }
  }
  return { message: String(error), stack: "" }
}

const firstFrame = (stack: string) => stack.split("\n").find((l) => l.trim().startsWith("at "))?.trim() ?? ""

function takeDaily(now: number): boolean {
  const store = getStore(STORE)
  const day = new Date(now).toISOString().slice(0, 10)
  const raw = store.get("sent") as { day?: string; n?: number } | undefined
  const n = raw?.day === day && typeof raw.n === "number" ? raw.n : 0
  if (n >= PER_DAY) return false
  store.set("sent", { day, n: n + 1 })
  return true
}

const persist = () => getStore(STORE).set("pending", queue.slice(-BATCH))

function schedule(ms = 4_000) {
  if (timer) return
  timer = setTimeout(() => void flush(), ms)
  timer.unref?.()
}

async function flush() {
  timer = null
  if (!queue.length) return
  if (!reportsEnabled()) {
    queue = []
    persist()
    return
  }
  const batch = queue.slice(0, BATCH)
  try {
    await apiRequest("POST", "/app/errors", { install_id: installId(), app: appInfo(), events: batch }, { timeoutMs: 15_000 })
    retries = 0
  } catch (error) {
    // offline or the service is busy: what is queued stays (also for the next start); a few tries, then quiet
    if (error instanceof GpunzNetworkError) {
      retries += 1
      if (retries <= 3) schedule(60_000 * retries)
      return
    }
    log("gpunz: error report refused", { message: error instanceof Error ? error.message : String(error) })
  }
  queue = queue.slice(batch.length)
  persist()
  if (queue.length) schedule()
}

/**
 * Report an error. Never throws and never waits: reporting must not be able to break the thing it reports on.
 * `facts` are small flat values about what the app was doing (never file names of the person's project).
 */
export function reportError(source: ReportSource, kind: string, error: unknown, facts?: Facts) {
  try {
    if (!reportsEnabled()) return
    const d = describeError(error)
    if (ignorable(d.message)) return
    const report: Report = {
      source,
      kind: kind.slice(0, 40),
      message: scrub(d.message, 2_000),
      stack: scrub(d.stack),
      context: { ...context(), ...facts },
    }
    const signature = `${source}|${kind}|${report.message.slice(0, 160)}|${firstFrame(report.stack)}`
    const now = Date.now()
    if ((seen.get(signature) ?? 0) > now - REPEAT_MS) return
    if (seen.size > 400) seen.clear()
    seen.set(signature, now)
    if (!takeDaily(now)) return
    queue.push(report)
    persist()
    schedule()
  } catch {
    // nothing: see above
  }
}

/** Start: what a previous run could not send (it crashed, or was offline) goes out now. */
export function initReports(deps: { log: typeof log }) {
  log = deps.log
  try {
    const pending = getStore(STORE).get("pending")
    if (Array.isArray(pending)) queue = (pending as Report[]).filter((r) => r && typeof r.message === "string").slice(-BATCH)
    if (queue.length) schedule(20_000)
  } catch {
    queue = []
  }
}

/** What every report says about the moment: the session's phase and the like. */
export function setReportContext(fn: () => Facts) {
  context = () => {
    try {
      return fn()
    } catch {
      return {}
    }
  }
}

export type FeedbackKind = "bug" | "idea" | "feedback"
export type FeedbackResult = { ok: true; id: string } | { ok: false; reason: "network" | "invalid" }

/** A message from the person to us. With the account's key it is tied to the account, so somebody can answer. */
export async function sendFeedback(
  input: { kind: FeedbackKind; message: string; email: string | null; diagnostics: string | null },
  key: string | null,
): Promise<FeedbackResult> {
  const body = {
    install_id: installId(),
    app: appInfo(),
    kind: input.kind,
    message: input.message,
    email: input.email,
    diagnostics: input.diagnostics ? scrub(input.diagnostics, 110_000) : null,
  }
  const post = (k: string | null) => apiRequest<{ id: string }>("POST", "/app/feedback", body, { key: k, timeoutMs: 30_000 })
  try {
    try {
      return { ok: true, id: (await post(key)).id }
    } catch (error) {
      // a key revoked in the console must not keep a person from writing to us
      if (key && error instanceof GpunzApiError && error.status === 401) return { ok: true, id: (await post(null)).id }
      throw error
    }
  } catch (error) {
    log("gpunz: feedback not sent", { message: error instanceof Error ? error.message : String(error) })
    return { ok: false, reason: error instanceof GpunzApiError ? "invalid" : "network" }
  }
}
