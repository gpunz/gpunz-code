import { app, BrowserWindow, ipcMain, Notification, shell } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import { CHANNEL, FROM_STORE, UPDATER_ENABLED } from "../constants"
import { diagnostics } from "../logging"
import { agentConfig, agentEnv } from "./agent-config"
import { type ApiTemplate, api, GpunzApiError, GpunzNetworkError, isSiteUrl, REPO_URL, SITE_URL } from "./api"
import { type Bridge, startBridge } from "./bridge"
import { customModel, mergeCatalog, validModelName } from "./catalog"
import { newerRelease } from "./release"
import { reportError, sendFeedback, setReportContext } from "./reports"
import { createSession, type Session } from "./session"
import {
  CUSTOM_MODEL_ID,
  CUSTOM_TEMPLATE,
  type FeedbackInput,
  type FeedbackResult,
  type GpunzAccount,
  type GpunzEstimate,
  type GpunzModel,
  type GpunzSettings,
  type GpunzState,
  type PickMode,
} from "./types"
import { clearKey, readEmail, readKey, readSettings, saveKey, saveSettings } from "./vault"

/**
 * gpu.nz Code in the main process: the account, the catalogue, the rented model and the bridge to it.
 * The renderer sees a state object (`gpunz-state` events) and sends intents; keys never cross the bridge to it.
 */
export type AgentStart = (env: Record<string, string>, identity: string) => Promise<void>

type Logger = { log: (message: string, meta?: Record<string, unknown>) => void }

export type GpunzController = Awaited<ReturnType<typeof createGpunz>>

export async function createGpunz(deps: { logger: Logger; startAgent: AgentStart }) {
  const { logger } = deps
  let account: GpunzAccount | null = null
  let login: GpunzState["login"] = null
  let loginRun = 0
  let templates: ApiTemplate[] | null = null
  let settings: GpunzSettings = readSettings()

  // the bridge first: the session and the agent's configuration both name it
  let session: Session | null = null
  const bridge: Bridge = await startBridge({
    onActivity: () => session?.noteActivity(),
    onSpeed: (tps) => session?.noteSpeed(tps),
    onTargetDown: () => session?.targetDown(),
    log: (message, meta) => logger.log(message, meta),
  })

  session = createSession({
    key: readKey,
    customModel,
    bridge,
    settings: () => settings,
    onChange: () => emit(),
    onModelReady: async (info) => {
      const config = agentConfig({
        bridgeUrl: bridge.url,
        bridgeKey: bridge.key,
        modelId: info.modelId,
        modelName: info.modelName,
        contextTokens: info.contextTokens,
      })
      // the agent is restarted only when what it was configured with changed (another model or window)
      await deps.startAgent(agentEnv(config), `${info.modelId}:${info.modelName}:${info.contextTokens}`)
    },
    onAuthLost: () => {
      // the key was revoked in the console (or expired after 90 days): ask to sign in again, keep nothing stale
      clearKey()
      account = null
      emit()
    },
    log: (message, meta) => logger.log(message, meta),
  })
  const live: Session = session

  /** a newer release this build cannot install by itself (see checkNewVersion) */
  let newVersion: string | null = null

  const state = (): GpunzState => ({
    signedIn: Boolean(readKey()),
    account,
    session: live.state(),
    login,
    settings,
    app: { version: app.getVersion(), selfUpdating: UPDATER_ENABLED, fromStore: FROM_STORE, newVersion },
  })

  // what an error report says about the moment: the phase of the session and whether somebody is signed in
  setReportContext(() => {
    const s = live.state()
    return { phase: s.phase, signedIn: Boolean(readKey()), model: s.phase === "ready" || s.phase === "launching" ? s.modelId : null }
  })

  /**
   * An installed release build that cannot update itself (macOS until the build has a Developer ID signature) still
   * tells the person a newer version is out; they download it from the site. A Store install is updated by the Store.
   */
  const noticesOnly = app.isPackaged && CHANNEL === "prod" && !UPDATER_ENABLED && !FROM_STORE
  async function checkNewVersion() {
    if (!noticesOnly && process.env.GPUNZ_UPDATE_NOTICE !== "1") return
    const found = await newerRelease(app.getVersion()).catch(() => null)
    if (found === newVersion) return
    newVersion = found
    emit()
  }

  /** The launch can take ten minutes: when the model answers and nobody is looking at the window, say so. */
  let lastPhase = "idle"
  function announce() {
    const phase = live.state().phase
    const was = lastPhase
    lastPhase = phase
    if (phase !== "ready" || was !== "launching") return
    const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    if (windows.some((w) => w.isFocused()) || !Notification.isSupported()) return
    const ru = [app.getLocale(), ...app.getPreferredSystemLanguages()].some((l) => l.toLowerCase().startsWith("ru"))
    const s = live.state()
    const name = s.phase === "ready" ? s.modelName : ""
    const note = new Notification({
      title: "gpu.nz Code",
      body: ru ? `${name} запущена — можно работать.` : `${name} is up — ready to work.`,
    })
    note.on("click", () => {
      const win = windows[0]
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    note.show()
    for (const w of windows) w.flashFrame(true)
  }

  /** A launch that failed for a reason the app has no words for is a bug of ours or a surprise of the service. */
  let lastUnknown = ""
  function noteUnknownError() {
    const s = live.state()
    const e = s.phase === "idle" ? s.lastError : undefined
    const message = e?.kind === "unknown" ? e.message : ""
    if (message && message !== lastUnknown) reportError("main", "session.unknown", { message, stack: "" })
    lastUnknown = message
  }

  function emit() {
    announce()
    noteUnknownError()
    const snapshot = state()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("gpunz-state", snapshot)
    }
  }

  async function refreshAccount() {
    const key = readKey()
    if (!key) {
      account = null
      return
    }
    try {
      const b = await api.balance(key)
      account = {
        email: account?.email ?? readEmail(),
        balanceKop: b.balance_kop,
        availableKop: b.available_kop,
        burnKopH: b.burn_kop_h,
        currency: b.currency,
      }
    } catch (error) {
      if (error instanceof GpunzApiError && error.status === 401) {
        clearKey()
        account = null
        live.detach()
      }
    }
    emit()
  }

  async function models(): Promise<GpunzModel[]> {
    if (!templates) {
      try {
        templates = (await api.templates()).data
      } catch {
        templates = null
      }
    }
    return mergeCatalog(templates)
  }

  /** The catalogue entry for an id; for the person's own model, by the name they typed. */
  async function resolveModel(modelId: string, customName?: string | null): Promise<GpunzModel | null> {
    if (modelId === CUSTOM_MODEL_ID) {
      const name = validModelName(customName ?? "")
      return name ? customModel(name) : null
    }
    return (await models()).find((m) => m.id === modelId) ?? null
  }

  async function estimate(modelId: string, mode: PickMode, customName?: string | null): Promise<GpunzEstimate> {
    const none: GpunzEstimate = {
      modelId,
      mode,
      available: false,
      gpuName: null,
      gpuSlug: null,
      country: null,
      verifiedHost: false,
      vramGb: null,
      priceKopH: 0,
      launchTrafficKop: 0,
      tokensPerSecond: null,
      contextTokens: null,
      launchMinutes: null,
      usdRub: null,
    }
    const model = await resolveModel(modelId, customName)
    if (!model) return { ...none, problem: "invalid_name" }
    let res: Awaited<ReturnType<typeof api.pick>>
    try {
      res = await api.pick(model.template, mode, null, model.custom ? model.model : null)
    } catch (error) {
      // the service says why it cannot size the model (details.reason)
      if (error instanceof GpunzApiError && error.status === 422) {
        const reason = error.details?.reason
        return {
          ...none,
          problem: reason === "model_unknown" ? "unknown_model" : reason === "model_too_big" ? "too_big" : "invalid_name",
        }
      }
      throw error
    }
    if (!res.offer || !res.estimate) return { ...none, sizeGb: res.estimate?.size_gb ?? null }
    return {
      ...none,
      available: true,
      gpuName: res.offer.gpu.name,
      gpuSlug: res.offer.gpu.slug,
      country: res.offer.country,
      verifiedHost: res.offer.verified,
      vramGb: res.offer.gpu.vram_gb,
      priceKopH: res.estimate.price_kop_h,
      launchTrafficKop: res.estimate.launch_traffic_kop,
      tokensPerSecond: res.estimate.tokens_per_second,
      contextTokens: res.estimate.context_tokens,
      launchMinutes: res.estimate.launch_minutes,
      usdRub: res.fx?.usd_rub ?? null,
      sizeGb: res.estimate.size_gb ?? null,
      minVramGb: res.estimate.min_vram_gb ?? null,
      problem: null,
    }
  }

  /** The device login: a code, the browser, then the key. Cancelled by another login or `cancelLogin`. */
  async function startLogin() {
    const mine = ++loginRun
    let flow: Awaited<ReturnType<typeof api.startDeviceLogin>>
    try {
      flow = await api.startDeviceLogin()
    } catch (error) {
      login = null
      emit()
      throw error
    }
    if (mine !== loginRun) return
    login = { userCode: flow.user_code, url: flow.verification_uri_complete, expiresAt: Date.now() + flow.expires_in * 1000 }
    emit()
    // only a page of the site itself is ever opened: the address comes over the network
    if (!isSiteUrl(flow.verification_uri_complete)) {
      login = null
      emit()
      throw new Error("unexpected sign-in address")
    }
    void shell.openExternal(flow.verification_uri_complete)
    let interval = Math.max(2, flow.interval) * 1000
    while (mine === loginRun && Date.now() < (login?.expiresAt ?? 0)) {
      await new Promise((r) => setTimeout(r, interval))
      if (mine !== loginRun) return
      try {
        const token = await api.pollDeviceLogin(flow.device_code)
        saveKey(token.api_key, token.user.email)
        account = { email: token.user.email, balanceKop: 0, availableKop: 0, burnKopH: 0, currency: "RUB" }
        login = null
        emit()
        await refreshAccount()
        void live.adopt(await models())
        return
      } catch (error) {
        if (error instanceof GpunzNetworkError) continue
        if (error instanceof GpunzApiError) {
          if (error.code === "authorization_pending") continue
          if (error.code === "slow_down") {
            interval += 2_000
            continue
          }
        }
        // denied or expired: back to the button
        break
      }
    }
    if (mine === loginRun) {
      login = null
      emit()
    }
  }

  /**
   * Our channels spend money and hold the account: they answer only the app's own page in a window's top frame
   * (oc://renderer), never a sub-frame or a page the window was somehow navigated to.
   */
  const trusted = (event: IpcMainInvokeEvent) => {
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame) return false
    try {
      const url = new URL(frame.url)
      return url.protocol === "oc:" && url.host === "renderer"
    } catch {
      return false
    }
  }
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>) =>
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error("forbidden")
      return fn(...(args as A))
    })

  handle("gpunz-get-state", () => state())
  handle("gpunz-login", () => {
    void startLogin().catch((error) => logger.log("gpunz: login failed", { message: String(error) }))
  })
  handle("gpunz-cancel-login", () => {
    loginRun++
    login = null
    emit()
  })
  handle("gpunz-logout", async () => {
    loginRun++
    login = null
    await live.stop().catch(() => undefined)
    clearKey()
    account = null
    emit()
  })
  handle("gpunz-models", () => models())
  const pickMode = (mode: unknown): PickMode => (mode === "fast" || mode === "cheap" ? mode : "balanced")
  const text = (v: unknown, max = 200): string => (typeof v === "string" ? v.slice(0, max) : "")
  handle("gpunz-estimate", (modelId: unknown, mode: unknown, customName?: unknown) =>
    estimate(text(modelId), pickMode(mode), text(customName) || null),
  )
  handle("gpunz-launch", async (modelIdRaw: unknown, modeRaw: unknown, customNameRaw?: unknown) => {
    const modelId = text(modelIdRaw)
    const mode = pickMode(modeRaw)
    const customName = text(customNameRaw) || null
    const model = await resolveModel(modelId, customName)
    if (!model) return
    settings = saveSettings({
      lastModelId: modelId,
      pickMode: mode,
      // the person's own models are remembered, the latest first
      ...(model.custom
        ? { customModels: [model.model, ...settings.customModels.filter((m) => m !== model.model)].slice(0, 6) }
        : {}),
    })
    emit()
    live.launch(model, mode)
  })
  // the agent without a model: old sessions, settings, MCP servers — nothing is rented, and a message sent to the
  // model gets the bridge's «launch a model first». A later launch with the same window does not restart the agent.
  handle("gpunz-open-agent", async () => {
    const list = await models()
    const model = list.find((m) => m.id === settings.lastModelId) ?? list[0]
    if (!model) return
    void CUSTOM_TEMPLATE
    const contextTokens = 65_536
    const config = agentConfig({
      bridgeUrl: bridge.url,
      bridgeKey: bridge.key,
      modelId: model.id,
      modelName: model.name,
      contextTokens,
    })
    await deps.startAgent(agentEnv(config), `${model.id}:${model.name}:${contextTokens}`)
  })
  handle("gpunz-stop", () => live.stop())
  handle("gpunz-extend", () => live.extend())
  handle("gpunz-activity", () => live.noteActivity())
  handle("gpunz-refresh", () => refreshAccount())
  handle("gpunz-set-settings", async (patch: Partial<GpunzSettings>) => {
    settings = saveSettings(patch)
    if (patch.idleStopMinutes !== undefined) await live.setIdleStop(settings.idleStopMinutes)
    emit()
    return settings
  })
  // an error the page caught: the same rules as our own (gpunz/reports.ts decides what is worth sending)
  handle("gpunz-report-error", (raw: unknown) => {
    const r = (raw && typeof raw === "object" ? raw : {}) as { kind?: unknown; message?: unknown; stack?: unknown }
    reportError("renderer", text(r.kind, 40) || "exception", { message: text(r.message, 4_000), stack: text(r.stack, 20_000) })
  })
  // «Помощь и обратная связь»: a bug, an idea or a word about the app, sent when the person presses the button
  handle("gpunz-feedback", async (raw: unknown): Promise<FeedbackResult> => {
    const input = (raw && typeof raw === "object" ? raw : {}) as Partial<FeedbackInput>
    const kind = input.kind === "idea" || input.kind === "feedback" ? input.kind : "bug"
    const message = text(input.message, 8_000).trim()
    if (message.length < 3) return { ok: false, reason: "invalid" }
    const email = text(input.email, 200).trim()
    return sendFeedback(
      {
        kind,
        message,
        email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null,
        diagnostics: input.includeLog ? diagnostics() : null,
      },
      readKey(),
    )
  })
  handle("gpunz-check-version", () => checkNewVersion())
  handle("gpunz-open", (target: string, amountRub?: number) => {
    // pages outside the console: the app's own page, its docs, its source
    const outside: Record<string, string> = {
      download: `${SITE_URL}/code`,
      docs: `${SITE_URL}/docs/code`,
      privacy: `${SITE_URL}/legal/privacy`,
      github: REPO_URL,
      issues: `${REPO_URL}/issues`,
    }
    const direct = outside[target]
    if (direct) {
      void shell.openExternal(direct)
      return
    }
    const path =
      target === "topup"
        ? `/console/billing${amountRub ? `?topup=${Math.max(100, Math.ceil(amountRub))}` : ""}`
        : target === "signup"
          ? "/register"
          : target === "support"
            ? "/console/support"
            : "/console"
    void shell.openExternal(`${SITE_URL}${path}`)
  })

  // the balance moves while a server runs; a top-up in the browser should show up without a restart
  const timer = setInterval(() => {
    const phase = live.state().phase
    if (readKey() && (phase !== "idle" || BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused()))) {
      void refreshAccount()
    }
  }, 30_000)
  timer.unref()

  void checkNewVersion()
  const versionTimer = setInterval(() => void checkNewVersion(), 6 * 60 * 60 * 1000)
  versionTimer.unref()

  if (readKey()) {
    account = { email: readEmail(), balanceKop: 0, availableKop: 0, burnKopH: 0, currency: "RUB" }
    void refreshAccount().then(async () => {
      if (readKey()) void live.adopt(await models())
    })
  }

  return {
    state,
    session: live,
    /** Quit: the server is deleted unless the person chose to keep it running. */
    async shutdown(deleteServer: boolean) {
      clearInterval(timer)
      clearInterval(versionTimer)
      if (deleteServer) await live.stop().catch(() => undefined)
      else live.detach()
      await bridge.close().catch(() => undefined)
    },
    hasServer: () => {
      const s = live.state()
      return s.phase === "ready" || s.phase === "launching"
    },
  }
}
