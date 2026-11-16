import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { manifestFacts, manifestName, newerRelease, releaseVerified, signatureValid, versionNewer } from "./release"

const { privateKey, publicKey } = generateKeyPairSync("ed25519")
const PUBLIC = publicKey.export({ type: "spki", format: "der" }).toString("base64")
const HASH_A = "a".repeat(86) + "=="
const HASH_B = "b".repeat(86) + "=="
const MANIFEST = `version: 0.2.0
files:
  - url: gpunz-code-win-x64.exe
    sha512: ${HASH_A}
    size: 129206292
path: gpunz-code-win-x64.exe
sha512: ${HASH_A}
releaseDate: '2026-11-12T10:19:00.000Z'
`
const signed = (text: string, key = privateKey) => sign(null, Buffer.from(text), key).toString("base64")

/** A feed that serves one manifest and one signature. */
const feed = (manifest: string | null, signature: string | null) =>
  (async (url: string | URL | Request) => {
    const body = String(url).endsWith(".sig") ? signature : manifest
    return body === null ? new Response("not found", { status: 404 }) : new Response(body)
  }) as typeof fetch

const INFO = { version: "0.2.0", sha512: HASH_A, files: [{ url: "gpunz-code-win-x64.exe", sha512: HASH_A }] }
const check = (info: typeof INFO | null, manifest: string | null, signature: string | null) =>
  releaseVerified(info, { fetcher: feed(manifest, signature), publicKey: PUBLIC, manifest: "latest.yml" })

describe("an update is taken only when we released it", () => {
  test("a manifest signed by the release key, naming the version and the file, is accepted", async () => {
    expect(await check(INFO, MANIFEST, signed(MANIFEST))).toEqual({ ok: true })
  })

  test("no signature, a signature of another key or of another text: refused", async () => {
    expect((await check(INFO, MANIFEST, null)).ok).toBe(false)
    const other = generateKeyPairSync("ed25519").privateKey
    expect(await check(INFO, MANIFEST, signed(MANIFEST, other))).toEqual({ ok: false, reason: "bad signature" })
    const tampered = MANIFEST.replace(HASH_A, HASH_B).replace(HASH_A, HASH_B)
    expect(await check({ ...INFO, sha512: HASH_B, files: [{ sha512: HASH_B }] }, tampered, signed(MANIFEST))).toEqual({
      ok: false,
      reason: "bad signature",
    })
    expect(signatureValid(Buffer.from(MANIFEST), "not base64 at all", PUBLIC)).toBe(false)
  })

  test("a signed manifest does not vouch for another file or another version", async () => {
    const sig = signed(MANIFEST)
    expect(await check({ ...INFO, files: [{ url: "x.exe", sha512: HASH_B }] }, MANIFEST, sig)).toEqual({
      ok: false,
      reason: "file hash not in the signed manifest",
    })
    expect(await check({ ...INFO, version: "9.9.9" }, MANIFEST, sig)).toEqual({
      ok: false,
      reason: "version differs from the signed manifest",
    })
    expect((await check({ version: "0.2.0", sha512: "", files: [] } as never, MANIFEST, sig)).ok).toBe(false)
    expect((await check(null, MANIFEST, sig)).ok).toBe(false)
  })

  test("a feed that is down is a «no», never an exception", async () => {
    const down = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    const verdict = await releaseVerified(INFO, { fetcher: down, publicKey: PUBLIC })
    expect(verdict.ok).toBe(false)
  })

  test("a build that cannot update itself learns of a newer release only from a signed manifest", async () => {
    const ask = (current: string, manifest: string | null, signature: string | null) =>
      newerRelease(current, { fetcher: feed(manifest, signature), publicKey: PUBLIC, manifest: "latest-mac.yml" })
    expect(await ask("0.1.0", MANIFEST, signed(MANIFEST))).toBe("0.2.0")
    expect(await ask("0.2.0", MANIFEST, signed(MANIFEST))).toBeNull()
    expect(await ask("0.10.0", MANIFEST, signed(MANIFEST))).toBeNull()
    // an unsigned or forged manifest says nothing, whatever version it names
    expect(await ask("0.1.0", MANIFEST, null)).toBeNull()
    expect(await ask("0.1.0", MANIFEST.replace("0.2.0", "9.9.9"), signed(MANIFEST))).toBeNull()
    expect(versionNewer("0.10.0", "0.9.9")).toBe(true)
    expect(versionNewer("1.0.0", "1.0.0")).toBe(false)
  })

  test("reads the manifest's version and hashes, and knows each system's manifest name", () => {
    const facts = manifestFacts(MANIFEST)
    expect(facts.version).toBe("0.2.0")
    expect([...facts.hashes]).toEqual([HASH_A])
    expect(manifestName("win32", "x64")).toBe("latest.yml")
    expect(manifestName("linux", "x64")).toBe("latest-linux.yml")
    expect(manifestName("linux", "arm64")).toBe("latest-linux-arm64.yml")
    expect(manifestName("darwin", "arm64")).toBe("latest-mac.yml")
  })
})
