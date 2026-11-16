import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow, dialog } from "electron"

import { Deferred, Effect } from "effect"
import contextMenu from "electron-context-menu"

import type { ServerReadyData } from "../preload/types"
import { checkAppExists, resolveAppPath } from "./apps"
import { CHANNEL } from "./constants"
import { registerIpcHandlers, sendMenuCommand } from "./ipc"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { createMenu } from "./menu"
import {
  finishFirstLaunchOnboarding,
  initializeOldLayoutEligibility,
  isFirstLaunchOnboardingPending,
  isOldLayoutEligible,
} from "./onboarding"
import {
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  spawnLocalServer,
  type SidecarListener,
} from "./server"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import { safeWebContentsURL } from "./window-state"
import {
  getLastFocusedWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setAppQuitting,
  setBackgroundColor,
  setDockIcon,
  restoreMainWindows,
} from "./windows"
import { createWslServersController } from "./wsl/servers"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { spawnWslSidecar } from "./wsl/sidecar"
import { migrate } from "./migrate"
import { cleanupStoreFiles } from "./store-cleanup"
import { setNativeTranslations } from "./native-translations"
import { createGpunz, type GpunzController } from "./gpunz/controller"
import { initReports, reportError } from "./gpunz/reports"

const APP_NAMES: Record<string, string> = {
  dev: "gpu.nz Code Dev",
  beta: "gpu.nz Code Beta",
  prod: "gpu.nz Code",
}
// our own ids: the app's settings and sessions never mix with an OpenCode install on the same computer
const APP_IDS: Record<string, string> = {
  dev: "nz.gpu.code.dev",
  beta: "nz.gpu.code.beta",
  prod: "nz.gpu.code",
}
const TEST_ONBOARDING = process.env.OPENCODE_TEST_ONBOARDING === "1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let server: SidecarListener | null = null
/** the app is closing: processes that end now end because we asked */
let quitting = false

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop()
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "nz.gpu.code.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.OPENCODE_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "gpu.nz Code Dev")
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  initializeOldLayoutEligibility(app.getPath("userData"))
  logger = initLogging()
  initCrashReporter()
  // gpu.nz Code: errors of the app itself reach its makers (gpunz/reports.ts: what is sent, and what never is).
  // The monitor only watches: what Electron does with an uncaught exception stays as it was.
  initReports({ log: (message, meta) => logger.log(message, meta) })
  process.on("uncaughtExceptionMonitor", (error) => reportError("main", "exception", error))
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled rejection", reason)
    reportError("main", "rejection", reason)
  })

  const wslServers = createWslServersController(
    app.getVersion(),
    async (distro) => {
      logger.log("spawning wsl sidecar", { distro })
      return spawnWslSidecar(distro, {
        onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
    },
  )
  const stopSidecars = async () => {
    await killSidecar()
    wslServers.stopAll()
  }
  const relaunch = () => {
    setAppQuitting()
    void stopSidecars().finally(() => {
      app.relaunch()
      app.quit()
    })
  }

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  preferAppEnv(app.getPath("userData"))
  // the agent's sessions live with this app, not in a stock OpenCode install's database
  process.env.OPENCODE_DB ??= join(app.getPath("userData"), "gpunz-code.db")

  // gpu.nz Code: links from outside (gpunzcode://…) are not acted on. Upstream lets a link open any folder as a
  // project and prefill a prompt; a project's own config can start programs (MCP servers, plugins), so a web page
  // could walk a person into running a stranger's code. Nothing of ours needs such links: sign-in is a code in the
  // browser. A link only brings the window forward.
  app.on("second-instance", (_event: Event, argv: string[]) => {
    if (argv.some((arg: string) => arg.startsWith("gpunzcode://")))
      logger.log("deep link ignored (second-instance)")
    const win = getLastFocusedWindow()
    if (win) {
      win.show()
      win.focus()
    }
  })

  app.on("open-url", (event: Event) => {
    event.preventDefault()
    logger.log("deep link ignored (open-url)")
    const win = getLastFocusedWindow()
    if (win) {
      win.show()
      win.focus()
    }
  })

  // quitting with a rented server: delete it (the default), leave it to the idle rule, or do not quit
  let quitDecided = false
  app.on("before-quit", (event) => {
    if (!quitDecided && gpunz?.hasServer()) {
      event.preventDefault()
      const ru = [app.getLocale(), ...app.getPreferredSystemLanguages()].some((l) => l.toLowerCase().startsWith("ru"))
      void dialog
        .showMessageBox({
          type: "question",
          buttons: ru
            ? ["Удалить сервер и выйти", "Оставить работать", "Отмена"]
            : ["Delete the server and quit", "Keep it running", "Cancel"],
          defaultId: 0,
          cancelId: 2,
          title: "gpu.nz Code",
          message: ru ? "Удалить арендованный сервер?" : "Delete the rented server?",
          detail: ru
            ? "Пока сервер работает, с баланса списываются деньги. На сервере ничего вашего нет: проекты и история остаются на этом компьютере. Оставленный сервер удалится сам после простоя, если это включено в настройках."
            : "The balance is charged while the server runs. Nothing of yours is on it: projects and history stay on this computer. A server left running is deleted by the idle rule, if it is on in the settings.",
        })
        .then(async (result) => {
          if (result.response === 2) return
          quitDecided = true
          await gpunz?.shutdown(result.response === 0).catch(() => undefined)
          app.quit()
        })
      return
    }
    setAppQuitting()
    void stopSidecars()
  })

  app.on("will-quit", () => {
    quitting = true
    setAppQuitting()
    void stopSidecars()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
    if (details.reason !== "clean-exit" && details.reason !== "killed")
      reportError(
        "native",
        "child-gone",
        { message: `${details.type} process gone: ${details.reason} (exit ${details.exitCode})`, stack: "" },
        { process: details.name ?? details.serviceName ?? details.type },
      )
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: safeWebContentsURL(webContents), details }, "error")
    if (details.reason !== "clean-exit" && details.reason !== "killed")
      reportError("native", "window-gone", {
        message: `window process gone: ${details.reason} (exit ${details.exitCode})`,
        stack: "",
      })
  })

  setRelaunchHandler(() => {
    relaunch()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      setAppQuitting()
      void stopSidecars().finally(() => app.quit())
    })
  }

  // gpu.nz Code: the agent server starts once a model is rented (gpunz/controller.ts), and again when the model
  // changes, so the «ready» promise the renderer waits on is replaced on each start
  let serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()
  let gpunz: GpunzController | null = null

  yield* Effect.promise(() => app.whenReady())

  if (!TEST_ONBOARDING) migrate()
  yield* Effect.promise(() => cleanupStoreFiles(app.getPath("userData"))).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        if (result.deleted.length === 0) return
        logger.log("cleaned scoped store files", { count: result.deleted.length, scanned: result.scanned })
      }),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to clean scoped store files", error)
      }),
    ),
  )
  // no link scheme is registered: the app takes nothing from links (see «second-instance» above)
  registerRendererProtocol()
  setDockIcon()
  const updater = setupAutoUpdater(stopSidecars)
  const menuDeps = {
    trigger: (id: string) => {
      const win = getLastFocusedWindow()
      if (win) sendMenuCommand(win, id)
    },
    checkForUpdates: () => void showUpdaterDialog(updater, true),
    relaunch,
  }
  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    relaunch,
    awaitInitialization: Effect.fnUntraced(
      function* () {
        logger.log("awaiting server ready")
        const current = serverReady
        const res = yield* Deferred.await(current)
        logger.log("server ready", { url: res.url })
        return res
      },
      (e) => Effect.runPromise(e),
    ),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    isFirstLaunchOnboardingPending,
    finishFirstLaunchOnboarding,
    isOldLayoutEligible,
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    updater,
    showUpdater: () => showUpdaterDialog(updater, true),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => {
      writeLog("renderer", "fatal renderer error", { ...error }, "error")
      // upstream's error screen: `error` is the message with its stack
      const [first = "", ...rest] = String(error.error ?? "").split("\n")
      reportError("renderer", "fatal", { message: first, stack: rest.join("\n") })
    },
    setNativeTranslations: (bundle) => {
      if (setNativeTranslations(bundle)) createMenu(menuDeps)
    },
  })
  registerWslIpcHandlers(wslServers)
  void updater.start()
  const updateTimer = setInterval(() => void updater.check(), 10 * 60 * 1000)
  updateTimer.unref()
  app.once("will-quit", () => clearInterval(updateTimer))
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  if (process.platform === "win32") {
    void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
  }

  // gpu.nz Code: the window opens at once with our own screens (sign in → model → launch); the agent server is
  // started by the controller when the rented model answers, with that model as its only provider.
  let agentIdentity: string | null = null
  const freePort = () =>
    new Promise<number>((resolve, reject) => {
      const fromEnv = Number.parseInt(process.env.OPENCODE_PORT ?? "", 10)
      if (!Number.isNaN(fromEnv)) return resolve(fromEnv)
      const socket = createServer()
      socket.on("error", reject)
      socket.listen(0, "127.0.0.1", () => {
        const address = socket.address()
        if (typeof address !== "object" || !address) {
          socket.close()
          reject(new Error("Failed to get port"))
          return
        }
        const port = address.port
        socket.close(() => resolve(port))
      })
    })
  const startAgent = async (env: Record<string, string>, identity: string) => {
    if (server && agentIdentity === identity) return
    const restart = Boolean(server)
    if (restart) {
      logger.log("restarting agent server for another model", { identity })
      await killSidecar()
      serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()
    }
    Object.assign(process.env, env)
    ensureLoopbackNoProxy()
    useEnvProxy()
    const hostname = "127.0.0.1"
    const port = await freePort()
    const url = `http://${hostname}:${port}`
    const password = randomUUID()
    logger.log("spawning sidecar", { url })
    try {
      const { listener, health } = await spawnLocalServer(hostname, port, password, {
        userDataPath: app.getPath("userData"),
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: (code) => {
          writeLog("utility", "sidecar exited", { code }, "warn")
          // the agent server died by itself (we stop it with `server` already cleared, or while quitting)
          if (code && server && !quitting)
            reportError("agent", "exit", { message: `agent server exited with code ${code}`, stack: "" })
        },
      })
      server = listener
      agentIdentity = identity
      Effect.runSync(Deferred.succeed(serverReady, { url, username: "opencode", password }))
      await Promise.race([health.wait, new Promise((resolve) => setTimeout(resolve, 30_000))]).catch((error) =>
        logger.error("sidecar health check failed", String(error)),
      )
      // windows that were talking to the previous server load again and pick up the new one
      if (restart) for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.reload()
    } catch (error) {
      logger.error("agent server failed to start", String(error))
      reportError("agent", "start", error)
      Effect.runSync(Deferred.fail(serverReady, error))
      throw error
    }
  }
  gpunz = yield* Effect.promise(() =>
    createGpunz({ logger: { log: (message, meta) => logger.log(message, meta) }, startAgent }),
  )

  app.on("window-all-closed", () => {
    if (process.platform === "darwin") return
    app.quit()
  })
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    restoreMainWindows()
  })

  const windows = restoreMainWindows()
  if (windows.length) createMenu(menuDeps)
})

Effect.runFork(main)
