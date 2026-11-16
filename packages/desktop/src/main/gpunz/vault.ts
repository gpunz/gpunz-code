import { safeStorage } from "electron"
import { getStore } from "../store"
import { DEFAULT_SETTINGS, type GpunzSettings } from "./types"

/**
 * What gpu.nz Code keeps between launches: the account key and a few settings.
 *
 * The key is encrypted with the operating system's own storage (DPAPI on Windows, Keychain on macOS, the secret
 * service on Linux) through Electron's safeStorage, and lives only in the main process. Where the system offers no
 * real encryption (a Linux session without a secret service: Electron would use a fixed password, or nothing), the
 * key is not written to disk at all — it stays in memory and the person signs in again at the next start. The key
 * can be revoked in the console at any time (it is listed there as «CLI · gpu.nz Code»).
 */
const STORE = "gpunz.account"
const KEY = "key"
const KEY_PLAIN = "keyPlain"
const EMAIL = "email"
const SETTINGS = "settings"

/** the key of a session that could not be stored safely */
let memoryKey: string | null = null

/** Whether the operating system really encrypts for us (not Electron's fixed-password fallback on Linux). */
function encryptionAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform !== "linux") return true
  try {
    return safeStorage.getSelectedStorageBackend() !== "basic_text"
  } catch {
    return false
  }
}

export function readKey(): string | null {
  if (memoryKey) return memoryKey
  const store = getStore(STORE)
  // a key an earlier build left in plain text is taken once and removed from the disk
  const plain = store.get(KEY_PLAIN)
  if (typeof plain === "string" && plain) {
    store.delete(KEY_PLAIN)
    saveKey(plain, readEmail())
    return plain
  }
  const enc = store.get(KEY)
  if (typeof enc === "string" && enc) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, "base64"))
    } catch {
      return null
    }
  }
  return null
}

export function saveKey(key: string, email: string | null) {
  const store = getStore(STORE)
  store.delete(KEY_PLAIN)
  if (encryptionAvailable()) {
    store.set(KEY, safeStorage.encryptString(key).toString("base64"))
    memoryKey = null
  } else {
    // nothing to encrypt with: the key lives until the app closes and is never written down
    store.delete(KEY)
    memoryKey = key
  }
  if (email) store.set(EMAIL, email)
  else store.delete(EMAIL)
}

export function clearKey() {
  memoryKey = null
  const store = getStore(STORE)
  store.delete(KEY)
  store.delete(KEY_PLAIN)
  store.delete(EMAIL)
}

export function readEmail(): string | null {
  const v = getStore(STORE).get(EMAIL)
  return typeof v === "string" ? v : null
}

export function readSettings(): GpunzSettings {
  const raw = getStore(STORE).get(SETTINGS)
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<GpunzSettings>
  const idle =
    s.idleStopMinutes === null
      ? null
      : typeof s.idleStopMinutes === "number" && s.idleStopMinutes >= 5 && s.idleStopMinutes <= 1440
        ? Math.round(s.idleStopMinutes)
        : DEFAULT_SETTINGS.idleStopMinutes
  const mode = s.pickMode === "fast" || s.pickMode === "cheap" || s.pickMode === "balanced" ? s.pickMode : "balanced"
  const custom = Array.isArray(s.customModels)
    ? s.customModels.filter((m): m is string => typeof m === "string" && m.length > 0 && m.length < 200).slice(0, 6)
    : []
  return {
    idleStopMinutes: idle,
    pickMode: mode,
    lastModelId: typeof s.lastModelId === "string" ? s.lastModelId : null,
    customModels: custom,
    errorReports: s.errorReports !== false,
  }
}

export function saveSettings(patch: Partial<GpunzSettings>): GpunzSettings {
  const next = { ...readSettings(), ...patch }
  getStore(STORE).set(SETTINGS, next)
  return readSettings()
}
