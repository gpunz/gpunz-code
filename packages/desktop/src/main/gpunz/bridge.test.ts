import { afterEach, describe, expect, test } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { type Bridge, startBridge } from "./bridge"

/** A stand-in for the model behind the gateway: records what it was asked and answers as told. */
type Upstream = {
  url: string
  seen: { path: string; auth: string | undefined; body: string }[]
  close: () => Promise<void>
}
async function upstream(
  answer: (req: http.IncomingMessage, res: http.ServerResponse, body: string, n: number) => void,
): Promise<Upstream> {
  const seen: Upstream["seen"] = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ path: req.url ?? "", auth: req.headers.authorization, body })
      answer(req, res, body, seen.length)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}
const html = (res: http.ServerResponse, status: number) => {
  res.writeHead(status, { "content-type": "text/html" })
  res.end("<!doctype html><title>gpu.nz</title>")
}

let bridge: Bridge | null = null
let up: Upstream | null = null
afterEach(async () => {
  await bridge?.close()
  await up?.close()
  bridge = null
  up = null
})

const ask = (b: Bridge, path: string, init: RequestInit = {}, key = b.key) =>
  fetch(`${b.url.replace(/\/v1$/, "")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
  })
const chat = (model = "chat-qwen38") =>
  JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: false })

describe("the local bridge to the rented model", () => {
  test("refuses anyone without its own key, and paths that are not the model's API", async () => {
    bridge = await startBridge()
    expect((await ask(bridge, "/v1/models", {}, "wrong")).status).toBe(401)
    expect((await fetch(`${bridge.url}/models`)).status).toBe(401)
    expect((await ask(bridge, "/etc/passwd")).status).toBe(404)
  })

  test("says so in JSON when no model is running", async () => {
    bridge = await startBridge()
    const res = await ask(bridge, "/v1/chat/completions", { method: "POST", body: chat() })
    expect(res.status).toBe(503)
    expect(res.headers.get("content-type")).toContain("json")
    const body = (await res.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe("gpunz_no_model")
    expect(body.error.message).toContain("Launch a model")
  })

  test("sends the request to the rented server with the rental's key and the server's model name", async () => {
    up = await upstream((_req, res) => json(res, 200, { choices: [{ message: { content: "ok" } }] }))
    const activity: number[] = []
    bridge = await startBridge({ onActivity: () => activity.push(Date.now()) })
    bridge.setTarget({ baseUrl: up.url, apiKey: "rental-key", model: "qwen3.8:27b" })
    const res = await ask(bridge, "/v1/chat/completions", { method: "POST", body: chat("chat-qwen38") })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { choices: unknown[] }).choices).toHaveLength(1)
    expect(up.seen).toHaveLength(1)
    expect(up.seen[0]?.path).toBe("/v1/chat/completions")
    // the agent's own key never leaves; the rental's goes upstream
    expect(up.seen[0]?.auth).toBe("Bearer rental-key")
    expect(JSON.parse(up.seen[0]?.body ?? "{}").model).toBe("qwen3.8:27b")
    expect(activity.length).toBeGreaterThan(0)
  })

  test("lists the model itself, without a round trip", async () => {
    up = await upstream((_req, res) => json(res, 500, {}))
    bridge = await startBridge()
    bridge.setTarget({ baseUrl: up.url, apiKey: "k", model: "qwen3.8:27b" })
    const res = await ask(bridge, "/v1/models")
    expect(((await res.json()) as { data: { id: string }[] }).data.map((m) => m.id)).toEqual(["qwen3.8:27b"])
    expect(up.seen).toHaveLength(0)
  })

  test("passes a stream through as it comes and measures its speed", async () => {
    up = await upstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      let i = 0
      const timer = setInterval(() => {
        res.write(`data: {"choices":[{"delta":{"content":"tok${i}"}}]}\n\n`)
        if (++i === 40) {
          clearInterval(timer)
          res.write(`data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":40}}\n\n`)
          res.end("data: [DONE]\n\n")
        }
      }, 20)
    })
    const speeds: number[] = []
    bridge = await startBridge({ onSpeed: (tps) => speeds.push(tps) })
    bridge.setTarget({ baseUrl: up.url, apiKey: "k", model: "m" })
    const res = await ask(bridge, "/v1/chat/completions", { method: "POST", body: chat() })
    expect(res.headers.get("content-type")).toContain("event-stream")
    const text = await res.text()
    expect(text).toContain("tok0")
    expect(text).toContain("tok39")
    expect(text).toContain("[DONE]")
    expect(speeds).toHaveLength(1)
    // 40 tokens in about 0.8 s
    expect(speeds[0]).toBeGreaterThan(20)
    expect(speeds[0]).toBeLessThan(200)
  })

  test("a request waits for a server that is on its way instead of failing", async () => {
    up = await upstream((_req, res) => json(res, 200, { ok: true }))
    bridge = await startBridge({}, { holdMs: 5_000 })
    bridge.setTarget(null, { pending: true })
    const pending = ask(bridge, "/v1/chat/completions", { method: "POST", body: chat() })
    const target = { baseUrl: up.url, apiKey: "k", model: "m" }
    setTimeout(() => bridge?.setTarget(target), 300)
    const res = await pending
    expect(res.status).toBe(200)
    expect(up.seen).toHaveLength(1)
  })

  test("and gets a clear error when it never comes", async () => {
    bridge = await startBridge({}, { holdMs: 300 })
    bridge.setTarget(null, { pending: true })
    const res = await ask(bridge, "/v1/chat/completions", { method: "POST", body: chat() })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("did not come up")
  })

  test("the gateway's HTML page is not shown to the agent: it retries, then tells the session", async () => {
    let down = 0
    up = await upstream((_req, res, _body, n) => (n < 3 ? html(res, 503) : json(res, 200, { ok: true })))
    bridge = await startBridge({ onTargetDown: () => down++ }, { retryMs: 20 })
    bridge.setTarget({ baseUrl: up.url, apiKey: "k", model: "m" })
    const res = await ask(bridge, "/v1/chat/completions", { method: "POST", body: chat() })
    // two HTML pages, then the model: the agent sees only the answer
    expect(res.status).toBe(200)
    expect(up.seen).toHaveLength(3)
    expect(down).toBe(2)
  })

  test("a server that stays down ends in a JSON error, never in HTML", async () => {
    up = await upstream((_req, res) => html(res, 502))
    bridge = await startBridge({}, { retryMs: 10 })
    bridge.setTarget({ baseUrl: up.url, apiKey: "k", model: "m" })
    const res = await ask(bridge, "/v1/chat/completions", { method: "POST", body: chat() })
    expect(res.status).toBe(503)
    expect(res.headers.get("content-type")).toContain("json")
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("gpunz_model_unreachable")
  })

  test("a model's own error (a JSON 4xx/5xx) is passed on as it is", async () => {
    up = await upstream((_req, res) => json(res, 400, { error: { message: "context length exceeded" } }))
    bridge = await startBridge({}, { retryMs: 10 })
    bridge.setTarget({ baseUrl: up.url, apiKey: "k", model: "m" })
    const res = await ask(bridge, "/v1/chat/completions", { method: "POST", body: chat() })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("context length exceeded")
    expect(up.seen).toHaveLength(1)
  })
})
