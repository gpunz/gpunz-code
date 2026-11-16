import { randomUUID } from "node:crypto"
import { type ApiInstance, api as realApi, GpunzApiError, GpunzNetworkError, isGatewayUrl } from "./api"
import type { Bridge } from "./bridge"
import type { GpunzModel, GpunzSession, GpunzSettings, PickMode, SessionError, SessionNote } from "./types"

/**
 * One rented model at a time, from the click to the delete.
 *
 *   idle → launching → ready → idle
 *
 * The service does the hard parts (picking a server, failing a broken host and giving the money back, deleting an
 * idle server); this is the part a person would otherwise do by hand: launch again on another server when a host
 * failed, notice that a running server went away and bring another one up under the same conversation, say «in use»
 * while the person works, and delete the server when they are done.
 */
const POLL_LAUNCH_MS = 3_000
const POLL_READY_MS = 10_000
const KEEPALIVE_MS = 55_000
/** a request or a keystroke in the last this many ms counts as «in use» */
const ACTIVE_WINDOW_MS = 90_000
/** hosts tried for one launch before the app stops and says so */
export const MAX_ATTEMPTS = 3
/** a running server that is not usable for this long is replaced */
const UNUSABLE_MS = 120_000
export const INSTANCE_NAME = "gpu.nz Code"
/**
 * One server may take this long to answer before it is deleted and counted as a failed host. Without a ceiling a
 * server that never becomes ready is kept alive (and billed) for as long as the app stays open.
 */
const LAUNCH_CEILING_MS = 30 * 60_000
/** servers replaced without the person asking (a host died, a server stopped answering) before the app stops and says so */
export const MAX_REPLACEMENTS = 3
const REPLACEMENT_WINDOW_MS = 60 * 60_000
/** answers of the service that are not about the server (5xx, 429, …) tolerated in a row before giving up on it */
const MAX_API_ERRORS = 5
/** a delete that did not go through is retried in the background this many more times, a minute apart */
const DESTROY_BACKGROUND_TRIES = 30

export type SessionApi = Pick<
  typeof realApi,
  "create" | "instance" | "instances" | "destroy" | "keepalive" | "balance" | "setIdleStop"
>

export type SessionDeps = {
  /** the service's API; a test passes its own */
  api?: SessionApi
  /** poll and retry pauses; a test shortens them */
  timing?: {
    launchMs?: number
    readyMs?: number
    unusableMs?: number
    retryMs?: number
    launchCeilingMs?: number
    destroyRetryMs?: number
  }
  /** does the model answer behind the gateway; a test passes its own */
  modelAnswers?: (llm: NonNullable<ApiInstance["llm"]>) => Promise<boolean>
  /** does the person's own model call tools; a test passes its own */
  toolCheck?: (llm: NonNullable<ApiInstance["llm"]>) => Promise<boolean | null>
  /** the catalogue entry for a model the person named themselves (to pick up such a server left running) */
  customModel?: (name: string) => GpunzModel
  key: () => string | null
  bridge: Bridge
  settings: () => GpunzSettings
  onChange: (session: GpunzSession) => void
  /** the model answers: (re)start the agent for it; resolves once the agent is up */
  onModelReady: (info: { modelId: string; modelName: string; model: string; contextTokens: number }) => Promise<void>
  onAuthLost: () => void
  log: (message: string, meta?: Record<string, unknown>) => void
}

export type Session = ReturnType<typeof createSession>

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function createSession(deps: SessionDeps) {
  const api = deps.api ?? realApi
  const launchMs = deps.timing?.launchMs ?? POLL_LAUNCH_MS
  const readyMs = deps.timing?.readyMs ?? POLL_READY_MS
  const unusableMs = deps.timing?.unusableMs ?? UNUSABLE_MS
  const retryMs = deps.timing?.retryMs ?? 2_000
  const launchCeilingMs = deps.timing?.launchCeilingMs ?? LAUNCH_CEILING_MS
  const destroyRetryMs = deps.timing?.destroyRetryMs ?? 60_000
  /** when servers were replaced on the app's own initiative (newest last) */
  let replacements: number[] = []
  let session: GpunzSession = { phase: "idle" }
  /** every launch, stop and adopt takes a new number; a loop that sees another number stops */
  let run = 0
  let lastActivity = 0
  let lastKeepalive = 0
  let speed: number | null = null

  const set = (next: GpunzSession) => {
    session = next
    deps.onChange(session)
  }
  const idle = (lastError?: SessionError) => {
    deps.bridge.setTarget(null)
    set(lastError ? { phase: "idle", lastError } : { phase: "idle" })
  }

  const errorOf = (error: unknown): SessionError => {
    if (error instanceof GpunzApiError) {
      if (error.status === 401) return { kind: "auth" }
      if (error.code === "insufficient_funds") {
        const d = error.details ?? {}
        return {
          kind: "insufficient_funds",
          needKop: typeof d.short_kop === "number" ? d.short_kop : null,
          currency: d.currency === "USD" ? "USD" : "RUB",
        }
      }
      if (error.code === "forbidden" && error.details?.reason === "email_not_verified") return { kind: "email_not_verified" }
      if (error.code === "conflict" || error.code === "gone" || error.code === "not_found") return { kind: "no_servers" }
      return { kind: "unknown", message: error.message }
    }
    if (error instanceof GpunzNetworkError) return { kind: "network", message: error.message }
    return { kind: "unknown", message: error instanceof Error ? error.message : String(error) }
  }

  /** An API call that waits out a lost connection instead of giving up (the server keeps running either way). */
  async function steady<T>(mine: number, call: () => Promise<T>): Promise<T | undefined> {
    for (let wait = retryMs; ; wait = Math.min(wait * 1.5, retryMs * 8)) {
      if (mine !== run) return undefined
      try {
        return await call()
      } catch (error) {
        if (!(error instanceof GpunzNetworkError)) throw error
        deps.log("session: network error, retrying", { message: error.message })
        await sleep(wait)
      }
    }
  }

  async function keepalive(key: string, id: string, force = false) {
    const now = Date.now()
    if (!force && now - lastKeepalive < KEEPALIVE_MS) return
    lastKeepalive = now
    await api.keepalive(key, id).catch((error) => deps.log("session: keepalive failed", { message: String(error) }))
  }

  async function destroyOnce(key: string, id: string): Promise<boolean> {
    try {
      await api.destroy(key, id)
      return true
    } catch (error) {
      // already gone is as good as deleted; a key that no longer works cannot delete anything
      if (error instanceof GpunzApiError && [401, 404, 409, 410].includes(error.status)) return true
      return false
    }
  }

  /**
   * Deletes a server and does not give up quietly: a few quick tries the caller waits for, then a minute apart in
   * the background with the same key (it is kept here, so signing out does not strand the server). A server that
   * still could not be deleted is picked up by `adopt` at the next sign-in, and by the idle rule when one is set.
   */
  async function destroyQuietly(key: string, id: string): Promise<boolean> {
    for (let i = 0; i < 4; i++) {
      if (await destroyOnce(key, id)) return true
      await sleep(retryMs * 1.5 * (i + 1))
    }
    deps.log("session: could not delete the server, retrying in the background", { id })
    void (async () => {
      for (let i = 0; i < DESTROY_BACKGROUND_TRIES; i++) {
        await sleep(destroyRetryMs)
        if (await destroyOnce(key, id)) {
          deps.log("session: the server is deleted", { id })
          return
        }
      }
      deps.log("session: the server could not be deleted", { id })
    })()
    return false
  }

  /** Whether the app may replace a server on its own once more; counts the replacement when it may. */
  function mayReplace(): boolean {
    const now = Date.now()
    replacements = replacements.filter((at) => now - at < REPLACEMENT_WINDOW_MS)
    if (replacements.length >= MAX_REPLACEMENTS) return false
    replacements.push(now)
    return true
  }

  /** the bar never goes back within one server's launch (the service drops `launch` just before «ready») */
  let shown = { id: "", percent: 0, stage: "pick" }
  const launchingState = (
    model: GpunzModel,
    attempt: number,
    inst: ApiInstance | null,
    note: SessionNote | null,
  ): GpunzSession => {
    const l = inst?.launch
    const id = inst?.id ?? ""
    if (shown.id !== id) shown = { id, percent: 0, stage: "pick" }
    shown = {
      id,
      percent: Math.max(shown.percent, l?.percent ?? (inst ? 1 : 0)),
      stage: l?.stage ?? (inst && shown.stage !== "pick" ? shown.stage : inst ? "start" : "pick"),
    }
    return {
      phase: "launching",
      modelId: model.id,
      modelName: model.name,
      attempt,
      instanceId: inst?.id ?? null,
      gpuName: inst?.gpu.name ?? null,
      priceKopH: inst?.price.running_kop_h ?? null,
      currency: inst?.currency ?? "RUB",
      percent: shown.percent,
      stage: shown.stage,
      stages: (l?.stages ?? []).map((s) => ({ id: s.id, state: s.state, percent: s.percent })),
      etaMinutes: l?.eta.kind === "minutes" ? (l.eta.minutes ?? null) : null,
      etaKind: l?.eta.kind ?? "minutes",
      usualMinutes: l?.usual_minutes ?? null,
      elapsedSeconds: l?.elapsed_seconds ?? 0,
      note,
    }
  }

  /** The gateway serves the model and the model is the one we asked for: only then is it «ready» for the agent. */
  async function modelAnswers(llm: NonNullable<ApiInstance["llm"]>): Promise<boolean> {
    if (deps.modelAnswers) return deps.modelAnswers(llm)
    try {
      const res = await fetch(`${llm.base_url}/models`, {
        headers: { authorization: `Bearer ${llm.api_key}`, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok || !String(res.headers.get("content-type")).includes("json")) return false
      const body = (await res.json()) as { data?: { id?: string }[] | null }
      return (body.data ?? []).length > 0
    } catch {
      return false
    }
  }

  /**
   * Can the model call a tool at all? A model we did not test may have no tool template (the server answers 400
   * «does not support tools») or may answer in prose: an agent on it can only talk. One short request, asked once.
   */
  async function callsTools(llm: NonNullable<ApiInstance["llm"]>): Promise<boolean | null> {
    if (deps.toolCheck) return deps.toolCheck(llm)
    try {
      const res = await fetch(`${llm.base_url}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${llm.api_key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: llm.model,
          stream: false,
          reasoning_effort: "none",
          max_tokens: 200,
          messages: [{ role: "user", content: "Call the list_files tool for the directory '.'. Do not answer in text." }],
          tools: [
            {
              type: "function",
              function: {
                name: "list_files",
                description: "List the files of a directory",
                parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
              },
            },
          ],
        }),
        signal: AbortSignal.timeout(120_000),
      })
      if (res.status === 400) return false
      if (!res.ok) return null
      const body = (await res.json()) as { choices?: { message?: { tool_calls?: unknown[] } }[] }
      return (body.choices?.[0]?.message?.tool_calls?.length ?? 0) > 0
    } catch {
      return null
    }
  }

  /**
   * Brings a server up for `model` and keeps at it across failed hosts. `adopt` is a server that already exists
   * (the app was closed while it ran). Ends in `ready` (and then watches), or in `idle` with the reason.
   */
  async function bringUp(
    mine: number,
    model: GpunzModel,
    mode: PickMode,
    gpu: string | null,
    adopt: ApiInstance | null,
    firstNote: SessionNote | null,
  ) {
    const key = deps.key()
    if (!key) {
      idle({ kind: "auth" })
      deps.onAuthLost()
      return
    }
    let note = firstNote
    let inst: ApiInstance | null = adopt
    deps.bridge.setTarget(null, { pending: true })
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (mine !== run) return
      set(launchingState(model, attempt, inst, note))
      if (!inst) {
        const idem = randomUUID()
        try {
          inst =
            (await steady(mine, () =>
              api.create(
                key,
                {
                  template: model.template,
                  pick: mode,
                  gpu,
                  idleStopMinutes: deps.settings().idleStopMinutes,
                  name: INSTANCE_NAME,
                  model: model.custom ? model.model : null,
                },
                idem,
              ),
            )) ?? null
        } catch (error) {
          const e = errorOf(error)
          if (e.kind === "auth") deps.onAuthLost()
          if (mine === run) idle(e)
          return
        }
        if (!inst) return
        if (mine !== run) {
          // stopped while the create was on its way: the server exists and must not be left behind
          void destroyQuietly(key, inst.id)
          return
        }
      }
      const id = inst.id
      lastKeepalive = 0
      const waitingSince = Date.now()
      let apiErrors = 0
      let gaveUp = false
      // wait for this server: ready, failed, or gone
      for (;;) {
        if (mine !== run) return
        set(launchingState(model, attempt, inst, note))
        void keepalive(key, id)
        if (inst.status === "failed" || inst.status === "destroyed" || inst.status === "destroying") break
        if (inst.llm && !isGatewayUrl(inst.llm.base_url)) {
          // the server's key is sent to our gateway and nowhere else, whatever address the answer carries
          deps.log("session: unexpected model address, refusing", { id })
          void destroyQuietly(key, id)
          if (mine === run) idle({ kind: "unknown", message: "unexpected model address" })
          return
        }
        if (inst.app?.ready && inst.llm?.model && (await modelAnswers(inst.llm))) {
          if (mine !== run) return
          await becomeReady(mine, model, mode, gpu, inst)
          return
        }
        if (Date.now() - waitingSince > launchCeilingMs) {
          // it never answered: delete it (it bills while it exists) and take another host
          deps.log("session: server did not answer within the ceiling, deleting", { id, status: inst.status })
          gaveUp = true
          break
        }
        await sleep(launchMs)
        try {
          const next: ApiInstance | undefined = await steady(mine, () => api.instance(key, id))
          if (!next) return
          inst = next
          apiErrors = 0
        } catch (error) {
          const e = errorOf(error)
          if (e.kind === "auth") {
            deps.onAuthLost()
            idle(e)
            return
          }
          // 404: deleted from under us
          if (error instanceof GpunzApiError && (error.status === 404 || error.status === 410)) break
          // anything else is the service having a moment, not news about the server: it still exists and bills
          if (++apiErrors < MAX_API_ERRORS) continue
          deps.log("session: the service keeps failing, deleting the server", { id, message: String(error) })
          void destroyQuietly(key, id)
          if (mine === run) idle(e)
          return
        }
      }
      if (gaveUp) {
        void destroyQuietly(key, id)
        note = { kind: "host_failed", attempt }
        inst = null
        continue
      }
      // this server did not make it
      const failure = inst.failure
      const stopReason = inst.stop_reason
      deps.log("session: server did not come up", { id, status: inst.status, failure: failure?.code, stopReason })
      if (stopReason === "idle") {
        idle({ kind: "idle_stopped", minutes: deps.settings().idleStopMinutes })
        return
      }
      if (inst.status !== "failed" || (failure && !failure.retry_elsewhere)) {
        // deleted by someone (the console, another device) or failed for a reason another host will not fix
        const balance = await api.balance(key).catch(() => null)
        idle(balance && balance.available_kop <= 0 ? { kind: "balance_zero" } : { kind: "stopped_elsewhere" })
        return
      }
      note = { kind: "host_failed", attempt }
      inst = null
    }
    if (mine === run) idle({ kind: "hosts_failed", attempts: MAX_ATTEMPTS })
  }

  async function becomeReady(mine: number, model: GpunzModel, mode: PickMode, gpu: string | null, inst: ApiInstance) {
    const key = deps.key()
    const llm = inst.llm
    if (!key || !llm?.model || !isGatewayUrl(llm.base_url)) return
    const contextTokens = llm.context_tokens ?? 32_768
    deps.bridge.setTarget({ baseUrl: llm.base_url, apiKey: llm.api_key, model: llm.model })
    try {
      await deps.onModelReady({ modelId: model.id, modelName: model.name, model: llm.model, contextTokens })
    } catch (error) {
      deps.log("session: agent did not start", { message: String(error) })
    }
    if (mine !== run) return
    lastActivity = Date.now()
    speed = null
    const toolsOk = model.custom ? await callsTools(llm) : null
    if (mine !== run) return
    const readyState = (i: ApiInstance, recovering = false): GpunzSession => ({
      phase: "ready",
      modelId: model.id,
      modelName: model.name,
      model: llm.model as string,
      instanceId: i.id,
      gpuName: i.gpu.name,
      country: i.country,
      priceKopH: i.price.running_kop_h,
      currency: i.currency,
      contextTokens,
      startedAt: Date.parse(i.created_at) || Date.now(),
      tokensPerSecond: speed,
      idleStopMinutes: i.idle_stop?.minutes ?? null,
      idleStopAt: i.idle_stop ? Date.parse(i.idle_stop.at) : null,
      recovering,
      toolsOk,
    })
    set(readyState(inst))
    await keepalive(key, inst.id, true)

    // watch it while it runs
    let unusableSince = 0
    let watchErrors = 0
    for (;;) {
      await sleep(readyMs)
      if (mine !== run) return
      let next: ApiInstance | undefined
      try {
        next = await steady(mine, () => api.instance(key, inst.id))
        watchErrors = 0
      } catch (error) {
        const e = errorOf(error)
        if (e.kind === "auth") {
          deps.onAuthLost()
          idle(e)
          return
        }
        if (mine !== run) return
        if (error instanceof GpunzApiError && (error.status === 404 || error.status === 410)) {
          // the server is gone
          idle({ kind: "stopped_elsewhere" })
          return
        }
        // the service having a moment: the server is still there, keep watching it; if it goes on, stop and delete
        // rather than leave a server nobody watches
        if (++watchErrors < MAX_API_ERRORS) continue
        deps.log("session: the service keeps failing, deleting the server", { id: inst.id, message: String(error) })
        void destroyQuietly(key, inst.id)
        idle(e)
        return
      }
      if (!next || mine !== run) return
      inst = next
      const usable = inst.status === "running" && inst.app?.ready !== false
      if (usable) {
        unusableSince = 0
        if (Date.now() - lastActivity < ACTIVE_WINDOW_MS) void keepalive(key, inst.id)
        set(readyState(inst))
        continue
      }
      if (inst.status === "failed" || inst.status === "destroyed" || inst.status === "destroying") {
        if (inst.stop_reason === "idle") {
          idle({ kind: "idle_stopped", minutes: inst.idle_stop?.minutes ?? deps.settings().idleStopMinutes })
          return
        }
        if (inst.status === "failed" && inst.failure?.retry_elsewhere !== false) {
          if (!mayReplace()) {
            // servers keep dying: renting a fourth one in an hour without asking is not ours to decide
            idle({ kind: "hosts_failed", attempts: MAX_REPLACEMENTS })
            return
          }
          // the host died under a working agent: another server, the same conversation
          run++
          const again = run
          void bringUp(again, model, mode, gpu, null, { kind: "host_lost" })
          return
        }
        const balance = await api.balance(key).catch(() => null)
        idle(balance && balance.available_kop <= 0 ? { kind: "balance_zero" } : { kind: "stopped_elsewhere" })
        return
      }
      // «starting», «stopped», or running with the app not answering: give the host a moment, then replace it
      unusableSince ||= Date.now()
      set(readyState(inst, true))
      if (Date.now() - unusableSince > unusableMs) {
        deps.log("session: server unusable too long, replacing", { id: inst.id, status: inst.status })
        void destroyQuietly(key, inst.id)
        if (!mayReplace()) {
          idle({ kind: "hosts_failed", attempts: MAX_REPLACEMENTS })
          return
        }
        run++
        const again = run
        void bringUp(again, model, mode, gpu, null, { kind: "host_lost" })
        return
      }
    }
  }

  return {
    state: () => session,
    /** A request reached the model, or the person is typing: the server is in use. */
    noteActivity() {
      lastActivity = Date.now()
    },
    noteSpeed(tokensPerSecond: number) {
      speed = Math.round(tokensPerSecond)
      if (session.phase === "ready") set({ ...session, tokensPerSecond: speed })
    },
    /** The bridge could not reach the server: do not wait for the next poll to find out why. */
    targetDown() {
      // the watch loop polls every 10 s and decides; nothing to do here but log it once
      deps.log("session: bridge reports the server unreachable")
    },
    launch(model: GpunzModel, mode: PickMode, gpu: string | null = null) {
      if (session.phase === "launching" || session.phase === "stopping") return
      const previous = session.phase === "ready" ? session.instanceId : null
      replacements = []
      run++
      const mine = run
      const key = deps.key()
      if (previous && key) void destroyQuietly(key, previous)
      void bringUp(mine, model, mode, gpu, null, null)
    },
    /** Deletes the server (or cancels a launch). Resolves when the service took the delete. */
    async stop() {
      const key = deps.key()
      const id = session.phase === "ready" || session.phase === "launching" ? session.instanceId : null
      run++
      deps.bridge.setTarget(null)
      if (!id || !key) {
        set({ phase: "idle" })
        return
      }
      set({ phase: "stopping", instanceId: id })
      await destroyQuietly(key, id)
      set({ phase: "idle" })
    },
    /** A server of ours that is still up (the app was closed while it ran): pick it up instead of renting another. */
    async adopt(models: GpunzModel[]): Promise<boolean> {
      const key = deps.key()
      if (!key || session.phase !== "idle") return false
      let list: ApiInstance[]
      try {
        list = (await api.instances(key)).data
      } catch {
        return false
      }
      // ours are the ones this app named; a server rented by hand in the console is not touched
      const mine = list
        .filter((i) => i.name === INSTANCE_NAME && i.desired_state === "running")
        .filter((i) => models.some((m) => m.template === i.template.slug) || deps.customModel)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      const inst = mine[0]
      const model = inst
        ? (models.find((m) => !m.custom && m.template === inst.template.slug) ??
          (inst.llm?.model && deps.customModel ? deps.customModel(inst.llm.model) : undefined))
        : undefined
      if (!inst || !model || session.phase !== "idle") return false
      run++
      void bringUp(run, model, deps.settings().pickMode, null, inst, null)
      return true
    },
    /** «Не выключать»: says the server is in use right now, whatever the idle clock shows. */
    async extend() {
      const key = deps.key()
      if (session.phase !== "ready" || !key) return
      lastActivity = Date.now()
      await keepalive(key, session.instanceId, true)
      const inst = await api.instance(key, session.instanceId).catch(() => null)
      if (inst && session.phase === "ready") {
        set({ ...session, idleStopAt: inst.idle_stop ? Date.parse(inst.idle_stop.at) : null })
      }
    },
    async setIdleStop(minutes: number | null) {
      const key = deps.key()
      if (session.phase !== "ready" || !key) return
      const inst = await api.setIdleStop(key, session.instanceId, minutes).catch(() => null)
      if (inst && session.phase === "ready") {
        set({
          ...session,
          idleStopMinutes: inst.idle_stop?.minutes ?? null,
          idleStopAt: inst.idle_stop ? Date.parse(inst.idle_stop.at) : null,
        })
      }
    },
    /** Signing out or quitting without a delete: the loops stop, the server is left to the idle rule. */
    detach() {
      run++
      deps.bridge.setTarget(null)
      session = { phase: "idle" }
    },
  }
}
