import { randomBytes, timingSafeEqual } from "node:crypto"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import https from "node:https"

/**
 * The local bridge between the agent and the rented model.
 *
 * The agent is configured once, with this bridge as its provider (http://127.0.0.1:<port>/v1 and a key that exists
 * only in this process). The bridge knows which server is rented right now and sends every request there:
 *
 *   - the server can change under a running agent (a host died, the user launched another model): nothing in the
 *     agent's configuration changes, and a request that arrives while the next server is starting waits for it
 *     instead of failing;
 *   - the rental's key never reaches the agent's files or the renderer;
 *   - the gateway answers a server that is not up with an HTML page; the agent gets a JSON error it can show;
 *   - this is where «is the model in use» and its speed are measured, for the idle rule and the status line.
 *
 * It listens on the loopback interface only and refuses a request without its own key, so another program on the
 * computer cannot spend the user's balance through it.
 */
export type BridgeTarget = {
  /** https://<id>-<port>.run.gpu.nz/v1 */
  baseUrl: string
  apiKey: string
  /** the model name the server knows; requests are rewritten to it */
  model: string
}

export type BridgeEvents = {
  /** a request reached the model (or is streaming): the server is in use */
  onActivity?: () => void
  /** an answer finished: tokens per second of its generation */
  onSpeed?: (tokensPerSecond: number) => void
  /** the gateway says the server is not there: the session should check on it */
  onTargetDown?: () => void
  log?: (message: string, meta?: Record<string, unknown>) => void
}

/** How long a request waits for a server that is being (re)started before it gets an error. */
const HOLD_MS = 12 * 60_000

export type Bridge = {
  url: string
  key: string
  setTarget: (target: BridgeTarget | null, opts?: { pending?: boolean }) => void
  close: () => Promise<void>
}

export async function startBridge(
  events: BridgeEvents = {},
  /** pauses; a test shortens them */
  timing: { holdMs?: number; retryMs?: number } = {},
): Promise<Bridge> {
  const holdMs = timing.holdMs ?? HOLD_MS
  const retryMs = timing.retryMs ?? 3_000
  const key = randomBytes(24).toString("base64url")
  let target: BridgeTarget | null = null
  /** a server is on its way: requests wait instead of failing */
  let pending = false
  let waiters: (() => void)[] = []

  const authorized = (req: IncomingMessage) => {
    const header = req.headers.authorization ?? ""
    const given = Buffer.from(header.replace(/^Bearer\s+/i, ""))
    const want = Buffer.from(key)
    return given.length === want.length && timingSafeEqual(given, want)
  }

  const fail = (res: ServerResponse, status: number, type: string, message: string) => {
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message, type, code: type } }))
  }

  const waitForTarget = async (): Promise<BridgeTarget | null> => {
    if (target) return target
    if (!pending) return null
    const deadline = Date.now() + holdMs
    while (!target && pending && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(2_000, holdMs))
        function done() {
          clearTimeout(timer)
          waiters = waiters.filter((w) => w !== done)
          resolve()
        }
        waiters.push(done)
      })
    }
    return target
  }

  const readBody = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => resolve(Buffer.concat(chunks)))
      req.on("error", reject)
    })

  /** One attempt against the current target. Resolves "retry" when nothing was sent to the client yet. */
  const forward = (
    req: IncomingMessage,
    res: ServerResponse,
    t: BridgeTarget,
    path: string,
    body: Buffer | null,
  ): Promise<"done" | "retry"> =>
    new Promise((resolve) => {
      const url = new URL(t.baseUrl.replace(/\/v1\/?$/, "") + path)
      const headers: Record<string, string> = {
        authorization: `Bearer ${t.apiKey}`,
        accept: String(req.headers.accept ?? "application/json"),
      }
      if (body) {
        headers["content-type"] = "application/json"
        headers["content-length"] = String(body.length)
      }
      const lib = url.protocol === "http:" ? http : https
      const started = Date.now()
      let firstByte = 0
      let pieces = 0
      let usageTokens: number | null = null
      let tail = ""
      const upstream = lib.request(url, { method: req.method, headers, timeout: 3_600_000 }, (up) => {
        const type = String(up.headers["content-type"] ?? "")
        const status = up.statusCode ?? 502
        // the gateway's own pages (the server is starting, gone, or the tunnel dropped) are HTML
        if (status >= 500 && !type.includes("json")) {
          up.resume()
          events.onTargetDown?.()
          resolve("retry")
          return
        }
        if ((status === 404 || status === 401 || status === 403) && !type.includes("json")) {
          up.resume()
          events.onTargetDown?.()
          resolve("retry")
          return
        }
        res.writeHead(status, {
          "content-type": type || "application/json",
          "cache-control": "no-store",
          ...(up.headers["transfer-encoding"] ? {} : up.headers["content-length"] ? { "content-length": String(up.headers["content-length"]) } : {}),
        })
        const stream = type.includes("event-stream")
        up.on("data", (chunk: Buffer) => {
          if (!firstByte) firstByte = Date.now()
          events.onActivity?.()
          if (stream) {
            // one data line per generated piece: count them, and read the usage block when the server sends one
            const text = tail + chunk.toString("utf8")
            const lines = text.split("\n")
            tail = lines.pop() ?? ""
            for (const line of lines) {
              if (!line.startsWith("data:")) continue
              if (line.includes('"content":"') || line.includes('"reasoning"') || line.includes('"tool_calls"')) pieces++
              const m = /"completion_tokens":\s*(\d+)/.exec(line)
              if (m) usageTokens = Number(m[1])
            }
          }
          res.write(chunk)
        })
        up.on("end", () => {
          res.end()
          const seconds = (Date.now() - (firstByte || started)) / 1000
          const tokens = usageTokens ?? pieces
          if (stream && tokens >= 20 && seconds > 0.5) events.onSpeed?.(tokens / seconds)
          resolve("done")
        })
        up.on("error", () => {
          res.end()
          resolve("done")
        })
      })
      upstream.on("timeout", () => upstream.destroy(new Error("timeout")))
      upstream.on("error", (error) => {
        events.log?.("bridge: upstream error", { message: error.message })
        if (res.headersSent) {
          res.end()
          resolve("done")
          return
        }
        events.onTargetDown?.()
        resolve("retry")
      })
      res.on("close", () => {
        if (!res.writableEnded) upstream.destroy()
      })
      if (body) upstream.write(body)
      upstream.end()
    })

  const server = http.createServer(async (req, res) => {
    try {
      if (!authorized(req)) return fail(res, 401, "unauthorized", "This address is for gpu.nz Code only.")
      const path = (req.url ?? "/").replace(/^\/+/, "/")
      if (!path.startsWith("/v1/")) return fail(res, 404, "not_found", "Unknown path.")

      let body: Buffer | null = null
      if (req.method === "POST") {
        body = await readBody(req)
        events.onActivity?.()
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        const t = await waitForTarget()
        if (!t) {
          return fail(
            res,
            503,
            "gpunz_no_model",
            pending
              ? "The model server did not come up in time. Check the launch in gpu.nz Code and send the message again."
              : "No model is running. Launch a model in gpu.nz Code and send the message again.",
          )
        }
        let payload = body
        if (body && path.startsWith("/v1/chat/completions")) {
          try {
            const json = JSON.parse(body.toString("utf8")) as Record<string, unknown>
            // the agent names the model by our catalogue id; the server knows it by its own name
            json.model = t.model
            payload = Buffer.from(JSON.stringify(json))
          } catch {
            payload = body
          }
        }
        if (req.method === "GET" && path.startsWith("/v1/models")) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ object: "list", data: [{ id: t.model, object: "model", owned_by: "gpunz" }] }))
          return
        }
        const outcome = await forward(req, res, t, path, payload)
        if (outcome === "done") return
        // nothing reached the client: wait a moment for the session to notice and bring a server back
        await new Promise((r) => setTimeout(r, retryMs + attempt * retryMs * 1.5))
      }
      fail(res, 503, "gpunz_model_unreachable", "The model server does not answer. gpu.nz Code is checking it; send the message again in a minute.")
    } catch (error) {
      events.log?.("bridge: request failed", { message: error instanceof Error ? error.message : String(error) })
      fail(res, 502, "gpunz_bridge_error", "The request could not be sent to the model.")
    }
  })
  server.keepAliveTimeout = 60_000

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (typeof address !== "object" || !address) throw new Error("bridge: no port")

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    key,
    setTarget(next, opts) {
      target = next
      pending = Boolean(opts?.pending)
      const list = waiters
      waiters = []
      for (const w of list) w()
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
