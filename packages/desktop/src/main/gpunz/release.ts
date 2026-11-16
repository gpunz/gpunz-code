import { createPublicKey, verify } from "node:crypto"

/**
 * Updates of gpu.nz Code.
 *
 * The app checks our own feed (never the upstream project's), downloads a newer version in the background and
 * offers «install and restart». The builds are not signed with a paid certificate yet, so the operating system's
 * signature check cannot vouch for an update. This does instead: every release's manifest (latest*.yml — the
 * version and the SHA-512 of each file) is signed with our Ed25519 release key, whose private half never leaves the
 * release machine. An update is taken only when the manifest's signature is valid AND the file the updater is about
 * to download has exactly a hash named in that signed manifest. Whoever breaks into the web server can then stop
 * updates, but cannot ship code to the installed copies; an older signed release cannot be replayed either
 * (downgrades are off).
 */
export const RELEASE_FEED = "https://gpu.nz/downloads/code"

/** The public half of the release key (SPKI DER, base64). The private half stays on the release machine. */
export const RELEASE_PUBLIC_KEY = "MCowBQYDK2VwAyEA6noTgNwO7P6JQ99OffTqB+etvc+HMgtYvY8fkiRvRrI="

/** The manifest electron-updater reads on this system (its own naming). */
export function manifestName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (platform === "darwin") return "latest-mac.yml"
  if (platform === "linux") return arch === "x64" ? "latest-linux.yml" : `latest-linux-${arch}.yml`
  return "latest.yml"
}

export function signatureValid(manifest: Uint8Array, signatureB64: string, publicKeyB64 = RELEASE_PUBLIC_KEY): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" })
    const signature = Buffer.from(signatureB64.trim(), "base64")
    return signature.length === 64 && verify(null, manifest, key, signature)
  } catch {
    return false
  }
}

/** The version and the file hashes a manifest names. A plain reader: the format is flat `key: value` lines. */
export function manifestFacts(text: string): { version: string | null; hashes: Set<string> } {
  const version = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1] ?? null
  const hashes = new Set<string>()
  for (const m of text.matchAll(/^\s*(?:-\s*)?sha512:\s*['"]?([A-Za-z0-9+/=]{80,100})['"]?\s*$/gm)) hashes.add(m[1] as string)
  return { version, hashes }
}

export type UpdateInfoLike = {
  version?: string
  sha512?: string
  files?: { url?: string; sha512?: string }[]
}

type FeedOptions = { fetcher?: typeof fetch; feed?: string; manifest?: string; publicKey?: string }

/** The feed's manifest for this system, taken only with a valid signature of our release key. */
async function signedManifest(
  options: FeedOptions = {},
): Promise<{ ok: true; facts: ReturnType<typeof manifestFacts> } | { ok: false; reason: string }> {
  const fetcher = options.fetcher ?? fetch
  const base = `${options.feed ?? RELEASE_FEED}/${options.manifest ?? manifestName()}`
  let manifest: Uint8Array
  let signature: string
  try {
    const [m, s] = await Promise.all([
      fetcher(base, { cache: "no-store", signal: AbortSignal.timeout(20_000) }),
      fetcher(`${base}.sig`, { cache: "no-store", signal: AbortSignal.timeout(20_000) }),
    ])
    if (!m.ok || !s.ok) return { ok: false, reason: `feed answered ${m.status}/${s.status}` }
    manifest = new Uint8Array(await m.arrayBuffer())
    signature = await s.text()
  } catch (error) {
    return { ok: false, reason: `feed unreachable: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (manifest.byteLength > 64 * 1024 || signature.length > 256) return { ok: false, reason: "unexpected size" }
  if (!signatureValid(manifest, signature, options.publicKey)) return { ok: false, reason: "bad signature" }
  return { ok: true, facts: manifestFacts(new TextDecoder().decode(manifest)) }
}

/**
 * Whether the update the updater found is one we released: the feed's manifest is signed by our key and names the
 * same version and the hash of every file about to be downloaded. Any doubt (no signature, a mismatch, the feed
 * changing between the two reads) is a «no» — the next check, ten minutes later, asks again.
 */
export async function releaseVerified(
  info: UpdateInfoLike | null | undefined,
  options: FeedOptions = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!info?.version) return { ok: false, reason: "no version" }
  const signed = await signedManifest(options)
  if (!signed.ok) return signed
  const facts = signed.facts
  if (facts.version !== info.version) return { ok: false, reason: "version differs from the signed manifest" }
  const wanted = [info.sha512, ...(info.files ?? []).map((f) => f.sha512)].filter((h): h is string => Boolean(h))
  if (!wanted.length) return { ok: false, reason: "no file hash" }
  if (!wanted.every((h) => facts.hashes.has(h))) return { ok: false, reason: "file hash not in the signed manifest" }
  return { ok: true }
}

/** «0.10.0» is newer than «0.9.2»; anything unreadable is not newer. */
export function versionNewer(a: string, b: string): boolean {
  const parts = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1, 4) ?? []).map(Number)
  const x = parts(a)
  const y = parts(b)
  if (x.length !== 3 || y.length !== 3) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) > (y[i] as number)
  return false
}

/**
 * For a build that cannot install updates itself (macOS until it has a Developer ID signature): the version of the
 * newest release, when it is newer than this one and its manifest carries our signature. The app then says «a new
 * version is out» and sends the person to the download page; nothing is downloaded or run by the app.
 */
export async function newerRelease(current: string, options: FeedOptions = {}): Promise<string | null> {
  const signed = await signedManifest(options)
  if (!signed.ok || !signed.facts.version) return null
  return versionNewer(signed.facts.version, current) ? signed.facts.version : null
}
