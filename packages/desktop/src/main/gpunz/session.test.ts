import { describe, expect, test } from "bun:test"
import { type ApiInstance, GpunzApiError, GpunzNetworkError } from "./api"
import type { Bridge, BridgeTarget } from "./bridge"
import { createSession, MAX_ATTEMPTS, MAX_REPLACEMENTS, type SessionApi } from "./session"
import { DEFAULT_SETTINGS, type GpunzModel, type GpunzSession } from "./types"

const MODEL: GpunzModel = {
  id: "chat-qwen38",
  template: "chat-qwen38",
  name: "Qwen 3.8 27B",
  description: "",
  model: "qwen3.8:27b",
  uncensored: false,
  verified: true,
  minVramGb: 24,
}

const inst = (id: string, over: Partial<ApiInstance> = {}): ApiInstance => ({
  id,
  name: "gpu.nz Code",
  status: "creating",
  desired_state: "running",
  gpu: { slug: "rtx-4090-24gb", name: "RTX 4090", count: 1, vram_gb: 24 },
  template: { slug: MODEL.id, name: "Qwen 3.8" },
  country: "FR",
  currency: "RUB",
  price: { running_kop_h: 5537, stopped_kop_h: 1100, traffic_kop_gb: 65 },
  cost_so_far_kop: 0,
  app: { ready: false, ready_at: null },
  llm: null,
  launch: {
    kind: "first",
    stage: "image",
    percent: 20,
    elapsed_seconds: 60,
    eta: { kind: "minutes", minutes: 6 },
    usual_minutes: { low: 5, high: 14 },
    stages: [
      { id: "book", state: "done", percent: 100, seconds: 5 },
      { id: "image", state: "active", percent: 30, seconds: 55 },
    ],
  },
  failure: null,
  idle_stop: { minutes: 30, at: new Date(Date.now() + 30 * 60_000).toISOString() },
  stop_reason: null,
  created_at: new Date().toISOString(),
  ...over,
})
const ready = (id: string): Partial<ApiInstance> => ({
  status: "running",
  app: { ready: true, ready_at: new Date().toISOString() },
  llm: { base_url: `https://${id}-21434.run.gpu.nz/v1`, api_key: `key-${id}`, model: "qwen3.8:27b", context_tokens: 65_536 },
  launch: null,
})
const failed = (code = "host_start_failed", retry = true): Partial<ApiInstance> => ({
  status: "failed",
  launch: null,
  failure: { code, retry_elsewhere: retry },
})

/** The service as a script: each server goes through the states given for it, one per poll. */
function world(script: Record<string, Partial<ApiInstance>[]>, opts: { create?: () => void; balance?: number } = {}) {
  const ids = Object.keys(script)
  const calls = { create: 0, destroy: [] as string[], keepalive: [] as string[], polls: 0 }
  const step: Record<string, number> = {}
  const at = (id: string) => {
    const states = script[id] ?? []
    const i = Math.min(step[id] ?? 0, states.length - 1)
    return inst(id, states[i] ?? {})
  }
  const api: SessionApi = {
    create: async () => {
      opts.create?.()
      const id = ids[calls.create]
      calls.create++
      if (!id) throw new GpunzApiError(409, "conflict", "gone")
      step[id] = 0
      return at(id)
    },
    instance: async (_key, id) => {
      calls.polls++
      if (!script[id]) throw new GpunzApiError(404, "not_found", "no such server")
      step[id] = (step[id] ?? 0) + 1
      return at(id)
    },
    instances: async () => ({ data: ids.filter((id) => step[id] !== undefined || calls.create === 0).map(at) }),
    destroy: async (_key, id) => {
      calls.destroy.push(id)
      return inst(id, { status: "destroying", desired_state: "destroyed" })
    },
    keepalive: async (_key, id) => {
      calls.keepalive.push(id)
      return at(id)
    },
    balance: async () => ({
      balance_kop: opts.balance ?? 50_000,
      available_kop: opts.balance ?? 50_000,
      burn_kop_h: 0,
      runway_hours: null,
      currency: "RUB",
    }),
    setIdleStop: async (_key, id, minutes) =>
      inst(id, { ...ready(id), idle_stop: minutes ? { minutes, at: new Date(Date.now() + minutes * 60_000).toISOString() } : null }),
  }
  return { api, calls }
}

function harness(api: SessionApi, key: string | null = "gpz_test", timing: Record<string, number> = {}) {
  const states: GpunzSession[] = []
  const targets: (BridgeTarget | null)[] = []
  const agent: string[] = []
  let authLost = 0
  const bridge: Bridge = {
    url: "http://127.0.0.1:1/v1",
    key: "local",
    setTarget: (t) => targets.push(t),
    close: async () => undefined,
  }
  const session = createSession({
    api,
    timing: { launchMs: 5, readyMs: 5, unusableMs: 40, retryMs: 5, destroyRetryMs: 10, ...timing },
    modelAnswers: async () => true,
    key: () => key,
    bridge,
    settings: () => DEFAULT_SETTINGS,
    onChange: (s) => states.push(s),
    onModelReady: async (info) => {
      agent.push(`${info.modelId}:${info.contextTokens}`)
    },
    onAuthLost: () => {
      authLost++
    },
    log: () => undefined,
  })
  const until = async (pred: (s: GpunzSession) => boolean, ms = 2_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (pred(session.state())) return session.state()
      await new Promise((r) => setTimeout(r, 3))
    }
    throw new Error(`timed out in phase ${session.state().phase}: ${JSON.stringify(session.state()).slice(0, 300)}`)
  }
  return { session, states, targets, agent, until, authLost: () => authLost }
}

describe("a rented model, from the click to the delete", () => {
  test("launches, shows the stages, and hands the model to the agent when it answers", async () => {
    const w = world({ a1: [{}, {}, ready("a1")] })
    const h = harness(w.api)
    h.session.launch(MODEL, "balanced")
    const s = await h.until((x) => x.phase === "ready")
    expect(s.phase === "ready" && s.instanceId).toBe("a1")
    expect(s.phase === "ready" && s.contextTokens).toBe(65_536)
    expect(s.phase === "ready" && s.gpuName).toBe("RTX 4090")
    // the launch was visible on the way, with the service's own numbers
    const launching = h.states.find((x) => x.phase === "launching" && x.instanceId === "a1")
    expect(launching?.phase === "launching" && launching.percent).toBe(20)
    expect(launching?.phase === "launching" && launching.stage).toBe("image")
    // the agent is configured for this model and window, the bridge points at the rental
    expect(h.agent).toEqual(["chat-qwen38:65536"])
    expect(h.targets.at(-1)).toEqual({
      baseUrl: "https://a1-21434.run.gpu.nz/v1",
      apiKey: "key-a1",
      model: "qwen3.8:27b",
    })
    // a launch is kept alive, or the idle rule would delete it while the person waits
    expect(w.calls.keepalive).toContain("a1")
    await h.session.stop()
    expect(w.calls.destroy).toEqual(["a1"])
    expect(h.session.state().phase).toBe("idle")
    expect(h.targets.at(-1)).toBeNull()
  })

  test("the progress never goes back while one server starts", async () => {
    // the service drops `launch` when the app is ready, a moment before the model answers the gateway
    const almost = { status: "running", app: { ready: true, ready_at: null }, llm: null, launch: null }
    const w = world({ m1: [{}, {}, almost, almost, ready("m1")] })
    const h = harness(w.api)
    h.session.launch(MODEL, "balanced")
    await h.until((x) => x.phase === "ready")
    const percents = h.states.flatMap((x) => (x.phase === "launching" && x.instanceId === "m1" ? [x.percent] : []))
    expect(percents.length).toBeGreaterThan(2)
    expect(percents).toEqual([...percents].sort((a, b) => a - b))
    expect(Math.min(...percents)).toBe(20)
    await h.session.stop()
  })

  test("a host that fails to start is replaced by another server, and the person is told", async () => {
    const w = world({ bad: [{}, failed()], good: [{}, ready("good")] })
    const h = harness(w.api)
    h.session.launch(MODEL, "balanced")
    const s = await h.until((x) => x.phase === "ready")
    expect(s.phase === "ready" && s.instanceId).toBe("good")
    expect(w.calls.create).toBe(2)
    const second = h.states.find((x) => x.phase === "launching" && x.attempt === 2)
    expect(second?.phase === "launching" && second.note).toEqual({ kind: "host_failed", attempt: 1 })
    // the failed one is the service's to clean up (it refunds and deletes it): we do not delete it twice
    expect(w.calls.destroy).toEqual([])
    await h.session.stop()
  })

  test("stops after three hosts in a row and says so", async () => {
    const w = world({ b1: [{}, failed()], b2: [failed("host_gpu_failed")], b3: [{}, failed("host_ssh_failed")] })
    const h = harness(w.api)
    h.session.launch(MODEL, "balanced")
    const s = await h.until((x) => x.phase === "idle" && Boolean(x.lastError))
    expect(s.phase === "idle" && s.lastError).toEqual({ kind: "hosts_failed", attempts: MAX_ATTEMPTS })
    expect(w.calls.create).toBe(3)
  })

  test("does not retry a failure another host would not fix", async () => {
    const w = world({ x1: [{}, failed("external", false)] })
    const h = harness(w.api)
    h.session.launch(MODEL, "balanced")
    const s = await h.until((x) => x.phase === "idle" && Boolean(x.lastError))
    expect(s.phase === "idle" && s.lastError?.kind).toBe("stopped_elsewhere")
    expect(w.calls.create).toBe(1)
  })

  test("not enough money: back to the model screen with the sum that is short", async () => {
    const api = world({}).api
    api.create = async () => {
      throw new GpunzApiError(402, "insufficient_funds", "no money", { short_kop: 4_200, currency: "RUB" })
    }
    const h = harness(api)
    h.session.launch(MODEL, "balanced")
    const s = await h.until((x) => x.phase === "idle" && Boolean(x.lastError))
    expect(s.phase === "idle" && s.lastError).toEqual({ kind: "insufficient_funds", needKop: 4_200, currency: "RUB" })
  })

  test("an unverified e-mail and an empty market are told apart", async () => {
    const api = world({}).api
    api.create = async () => {
      throw new GpunzApiError(403, "forbidden", "not ready", { reason: "email_not_verified" })
    }
    const h = harness(api)
    h.session.launch(MODEL, "balanced")
    expect((await h.until((x) => x.phase === "idle" && Boolean(x.lastError))).phase === "idle").toBe(true)
    const e1 = h.session.state()
    expect(e1.phase === "idle" && e1.lastError?.kind).toBe("email_not_verified")

    const h2 = harness(world({}).api)
    h2.session.launch(MODEL, "balanced")
    const e2 = await h2.until((x) => x.phase === "idle" && Boolean(x.lastError))
    expect(e2.phase === "idle" && e2.lastError?.kind).toBe("no_servers")
  })

  test("a lost connection is waited out, not treated as a failure", async () => {
    const w = world({ n1: [{}, ready("n1")] })
    let drops = 2
    const instance = w.api.instance
    w.api.instance = async (key, id) => {
      if (drops-- > 0) throw new GpunzNetworkError("offline")
      return instance(key, id)
    }
    const h = harness(w.api)
    h.session.launch(MODEL, "balanced")
    const s = await h.until((x) => x.phase === "ready")
    expect(s.phase === "ready" && s.instanceId).toBe("n1")
    expect(w.calls.create).toBe(1)
    await h.session.stop()
  })

  test("a revoked key ends the session and asks to sign in again", async () => {
    const api = world({}).api
    api.create = async () => {
      throw new GpunzApiError(401, "unauthorized", "bad key")
    }
    const h = harness(api)
    h.session.launch(MODEL, "balanced")
    const s = await h.until((x) => x.phase === "idle" && Boolean(x.lastError))
    expect(s.phase === "idle" && s.lastError?.kind).toBe("auth")
    expect(h.authLost()).toBe(1)
  })

  test("a server that dies under a working agent is replaced, the agent keeps its configuration", async () => {
    const w = world({ r1: [ready("r1"), ready("r1"), failed("host_offline")], r2: [{}, ready("r2")] })
    const h = harness(w.api)
    h.session.launch(MODEL, "balanced")
    await h.until((x) => x.phase === "ready" && x.instanceId === "r1")
    const s = await h.until((x) => x.phase === "ready" && x.instanceId === "r2")
    expect(s.phase).toBe("ready")
    // requests wait for the next server (pending), then go to it
    const lost = h.states.find((x) => x.phase === "launching" && x.note?.kind === "host_lost")
    expect(lost).toBeDefined()
    expect(h.targets.at(-1)?.apiKey).toBe("key-r2")
    // same model, same window: the agent is told again with the same identity (the starter skips a restart)
    expect(h.agent).toEqual(["chat-qwen38:65536", "chat-qwen38:65536"])
    await h.session.stop()
  })

  test("a server deleted by the idle rule is reported as that, and nothing is rented again", async () => {
    const w = world({ i1: [ready("i1"), ready("i1"), { status: "destroyed", stop_reason: "idle", idle_stop: null, launch: null }] })
    const h = harness(w.api)
    h.session.launch(MODEL, "balanced")
    await h.until((x) => x.phase === "ready")
    const s = await h.until((x) => x.phase === "idle")
    expect(s.phase === "idle" && s.lastError).toEqual({ kind: "idle_stopped", minutes: 30 })
    expect(w.calls.create).toBe(1)
    expect(h.targets.at(-1)).toBeNull()
  })

  test("a server deleted at zero balance says to top up; one deleted elsewhere says that", async () => {
    const gone = { status: "destroyed", launch: null } as const
    const broke = world({ z1: [ready("z1"), gone] }, { balance: 0 })
    const h = harness(broke.api)
    h.session.launch(MODEL, "balanced")
    const s = await h.until((x) => x.phase === "idle" && Boolean(x.lastError))
    expect(s.phase === "idle" && s.lastError?.kind).toBe("balance_zero")

    const elsewhere = world({ z2: [ready("z2"), gone] }, { balance: 90_000 })
    const h2 = harness(elsewhere.api)
    h2.session.launch(MODEL, "balanced")
    const s2 = await h2.until((x) => x.phase === "idle" && Boolean(x.lastError))
    expect(s2.phase === "idle" && s2.lastError?.kind).toBe("stopped_elsewhere")
  })

  test("a running server that stops answering for too long is deleted and replaced", async () => {
    const stuck = { status: "starting", app: { ready: false, ready_at: null }, launch: null } as const
    const w = world({ u1: [ready("u1"), ready("u1"), stuck], u2: [{}, ready("u2")] })
    const h = harness(w.api)
    h.session.launch(MODEL, "balanced")
    await h.until((x) => x.phase === "ready" && x.instanceId === "u1")
    // first it is shown as «checking», not thrown away at once
    await h.until((x) => x.phase === "ready" && x.recovering)
    const s = await h.until((x) => x.phase === "ready" && x.instanceId === "u2")
    expect(s.phase).toBe("ready")
    expect(w.calls.destroy).toContain("u1")
    await h.session.stop()
  })

  test("cancelling a launch deletes the server that was being started", async () => {
    const w = world({ c1: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, ready("c1")] })
    const h = harness(w.api)
    h.session.launch(MODEL, "balanced")
    await h.until((x) => x.phase === "launching" && x.instanceId === "c1")
    await h.session.stop()
    expect(w.calls.destroy).toEqual(["c1"])
    expect(h.session.state().phase).toBe("idle")
    // the old loop is gone: nothing becomes ready later
    await new Promise((r) => setTimeout(r, 120))
    expect(h.session.state().phase).toBe("idle")
    expect(h.agent).toEqual([])
  })

  test("a server left running by a closed app is picked up instead of renting another", async () => {
    const w = world({ p1: [ready("p1")] })
    const h = harness(w.api)
    expect(await h.session.adopt([MODEL])).toBe(true)
    const s = await h.until((x) => x.phase === "ready")
    expect(s.phase === "ready" && s.instanceId).toBe("p1")
    expect(w.calls.create).toBe(0)
    // nothing of ours running: nothing to pick up
    const empty = world({})
    expect(await harness(empty.api).session.adopt([MODEL])).toBe(false)
    await h.session.stop()
  })

  test("says «in use» only while there was work in the last minute and a half", async () => {
    const w = world({ k1: [ready("k1")] })
    const h = harness(w.api)
    h.session.launch(MODEL, "balanced")
    await h.until((x) => x.phase === "ready")
    const after = w.calls.keepalive.length
    // activity was just noted at ready; the keepalive itself is rate-limited to one in 55 s
    await new Promise((r) => setTimeout(r, 60))
    expect(w.calls.keepalive.length).toBe(after)
    await h.session.extend()
    expect(w.calls.keepalive.length).toBe(after + 1)
    await h.session.stop()
  })

  test("a server that never answers is deleted after the ceiling, and three such in a row stop the launch", async () => {
    const never = [{ status: "running", launch: null, app: { ready: false, ready_at: null } }] as Partial<ApiInstance>[]
    const w = world({ n1: never, n2: never, n3: never, n4: never })
    const h = harness(w.api, "gpz_test", { launchCeilingMs: 40 })
    h.session.launch(MODEL, "balanced")
    const s = await h.until((x) => x.phase === "idle" && Boolean(x.lastError))
    expect(s.phase === "idle" && s.lastError).toEqual({ kind: "hosts_failed", attempts: MAX_ATTEMPTS })
    // none of them is left running (and billing)
    expect(w.calls.destroy.sort()).toEqual(["n1", "n2", "n3"])
    expect(w.calls.create).toBe(3)
  })

  test("servers that keep dying under the agent are replaced three times in an hour, then the app stops", async () => {
    const dies = (id: string) => [ready(id), ready(id), failed("host_offline")]
    const w = world({ d1: dies("d1"), d2: dies("d2"), d3: dies("d3"), d4: dies("d4"), d5: dies("d5") })
    const h = harness(w.api)
    h.session.launch(MODEL, "balanced")
    const s = await h.until((x) => x.phase === "idle" && Boolean(x.lastError), 5_000)
    expect(s.phase === "idle" && s.lastError).toEqual({ kind: "hosts_failed", attempts: MAX_REPLACEMENTS })
    // the one the person asked for and three replacements; a fifth is never rented without asking
    expect(w.calls.create).toBe(1 + MAX_REPLACEMENTS)
  })

  test("the service failing for a moment is waited out; failing on and on, the server is deleted, not abandoned", async () => {
    const w = world({ e1: [{}, {}, {}, ready("e1")] })
    const real = w.api.instance
    let failures = 2
    w.api.instance = async (key, id) => {
      if (failures-- > 0) throw new GpunzApiError(503, "unavailable", "try later")
      return real(key, id)
    }
    const h = harness(w.api)
    h.session.launch(MODEL, "balanced")
    await h.until((x) => x.phase === "ready" && x.instanceId === "e1")
    expect(w.calls.destroy).toEqual([])
    await h.session.stop()

    const w2 = world({ e2: [{}, {}] })
    w2.api.instance = async () => {
      throw new GpunzApiError(500, "internal", "broken")
    }
    const h2 = harness(w2.api)
    h2.session.launch(MODEL, "balanced")
    const s = await h2.until((x) => x.phase === "idle" && Boolean(x.lastError))
    expect(s.phase === "idle" && s.lastError?.kind).toBe("unknown")
    expect(w2.calls.destroy).toContain("e2")
  })

  test("a delete that does not go through is retried in the background until it does", async () => {
    const w = world({ k1: [ready("k1")] })
    let refusals = 6
    let deleted = 0
    w.api.destroy = async (_key, id) => {
      if (refusals-- > 0) throw new GpunzApiError(502, "bad_gateway", "later")
      deleted++
      return inst(id, { status: "destroying", desired_state: "destroyed" })
    }
    const h = harness(w.api)
    h.session.launch(MODEL, "balanced")
    await h.until((x) => x.phase === "ready")
    await h.session.stop()
    expect(h.session.state().phase).toBe("idle")
    // the four quick tries failed; the background ones finish the job
    const end = Date.now() + 2_000
    while (!deleted && Date.now() < end) await new Promise((r) => setTimeout(r, 5))
    expect(deleted).toBe(1)
  })

  test("the server's key is never sent to an address that is not our gateway", async () => {
    const elsewhere: Partial<ApiInstance> = {
      ...ready("x1"),
      llm: { base_url: "https://evil.example/v1", api_key: "key-x1", model: "qwen3.8:27b", context_tokens: 65_536 },
    }
    const w = world({ x1: [{}, elsewhere] })
    let asked = 0
    const h = harness(w.api)
    const session = createSession({
      api: w.api,
      timing: { launchMs: 5, readyMs: 5, retryMs: 5 },
      modelAnswers: async () => {
        asked++
        return true
      },
      key: () => "gpz_test",
      bridge: { url: "http://127.0.0.1:1/v1", key: "local", setTarget: (t) => h.targets.push(t), close: async () => undefined },
      settings: () => DEFAULT_SETTINGS,
      onChange: () => undefined,
      onModelReady: async () => undefined,
      onAuthLost: () => undefined,
      log: () => undefined,
    })
    session.launch(MODEL, "balanced")
    const end = Date.now() + 2_000
    while (session.state().phase !== "idle" && Date.now() < end) await new Promise((r) => setTimeout(r, 5))
    expect(session.state().phase).toBe("idle")
    expect(asked).toBe(0)
    expect(h.targets.every((t) => !t || !("apiKey" in t) || t.apiKey !== "key-x1")).toBe(true)
    expect(w.calls.destroy).toContain("x1")
  })
})
