import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// gpu.nz Code updates itself from our own feed only (gpunz/release.ts; never the upstream project's), and only as an
// installed release build. Not on macOS yet: its updater refuses an app without a Developer ID signature. Not in a
// Microsoft Store install either: the Store delivers its updates.
/** Installed from the Microsoft Store (a packaged app): the Store updates it, our own updater stays out of the way. */
export const FROM_STORE = Boolean((process as { windowsStore?: boolean }).windowsStore)
export const UPDATER_ENABLED = app.isPackaged && CHANNEL === "prod" && process.platform !== "darwin" && !FROM_STORE
