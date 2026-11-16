// smoke.mjs — starts the packaged app from dist/, waits for our first screen and checks the version it reports.
// Run by the desktop workflow on every system after packaging: a build that cannot start never becomes a release.
//   node scripts/smoke.mjs [screenshot.png]
import { spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const dist = join(import.meta.dirname, "..", "dist")
const version = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version
const shot = process.argv[2]
const port = 9333

function executable() {
  if (process.platform === "win32") return join(dist, "win-unpacked", "gpu.nz Code.exe")
  if (process.platform === "darwin") {
    const dir = readdirSync(dist).find((d) => d.startsWith("mac") && existsSync(join(dist, d, "gpu.nz Code.app")))
    if (!dir) throw new Error("no .app in dist")
    return join(dist, dir, "gpu.nz Code.app", "Contents", "MacOS", "gpu.nz Code")
  }
  return join(dist, "linux-unpacked", "nz.gpu.code")
}

const exe = executable()
if (!existsSync(exe)) throw new Error(`not built: ${exe}`)
console.log("starting", exe)
const child = spawn(exe, [`--remote-debugging-port=${port}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])], {
  // a throwaway profile (upstream's onboarding-test switch) and no error reports from a test run
  env: { ...process.env, OPENCODE_TEST_ONBOARDING: "1", GPUNZ_REPORTS: "0" },
  stdio: ["ignore", "inherit", "inherit"],
})
let exited = null
child.on("exit", (code, signal) => (exited = { code, signal }))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stop = () => {
  if (exited) return
  if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
  else child.kill("SIGKILL")
}

async function page() {
  for (let i = 0; i < 120; i++) {
    if (exited) throw new Error(`the app exited at start: ${JSON.stringify(exited)}`)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const target = list.find((t) => t.type === "page" && String(t.url).startsWith("oc://renderer"))
      if (target) return target
    } catch {
      // not listening yet
    }
    await sleep(500)
  }
  throw new Error("no window in 60 seconds")
}

async function main() {
  const target = await page()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error("no connection to the window"))
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const done = pending.get(message.id)
    if (!done) return
    pending.delete(message.id)
    done(message)
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mine = ++id
      pending.set(mine, resolve)
      ws.send(JSON.stringify({ id: mine, method, params }))
    })
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 600))
    return res.result?.result?.value
  }
  // our gate is the first screen of a copy nobody has signed in to
  const seen = await evaluate(`new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const gate = Boolean(document.querySelector(".gz-gate"))
      if (gate || Date.now() - started > 30000) {
        clearInterval(timer)
        resolve(JSON.stringify({ gate, title: document.title, text: document.body.innerText.slice(0, 160) }))
      }
    }, 250)
  })`)
  const state = await evaluate("window.api.gpunz.getState().then((s) => JSON.stringify(s.app))")
  console.log("window:", seen)
  console.log("app:", state)
  if (shot) {
    await sleep(1500)
    const png = await send("Page.captureScreenshot", { format: "png" })
    if (png.result?.data) writeFileSync(shot, Buffer.from(png.result.data, "base64"))
  }
  ws.close()
  if (!JSON.parse(seen).gate) throw new Error("the first screen did not appear")
  if (JSON.parse(state).version !== version) throw new Error(`version ${JSON.parse(state).version}, expected ${version}`)
  console.log("smoke test passed:", version, process.platform, process.arch)
}

main()
  .then(() => {
    stop()
    setTimeout(() => process.exit(0), 1500)
  })
  .catch((error) => {
    console.error("SMOKE TEST FAILED:", error.message)
    stop()
    setTimeout(() => process.exit(1), 1500)
  })
