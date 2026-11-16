import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

const channels = [
  { channel: "dev", appId: "nz.gpu.code.dev" },
  { channel: "beta", appId: "nz.gpu.code.beta" },
  { channel: "prod", appId: "nz.gpu.code" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
    expect(config.deb?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
    expect(config.rpm?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
  })
}

test("ships nothing under the upstream project's names", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "prod"

  const module = await import("./electron-builder.config.ts?own-names=prod")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.productName).toBe("gpu.nz Code")
  expect(config.artifactName).toStartWith("gpunz-code-")
  expect(JSON.stringify(config.publish)).toContain("https://gpu.nz/downloads/code")
  for (const entry of [...(config.deb?.fpm ?? []), ...(config.rpm?.fpm ?? [])]) expect(entry).not.toContain("opencode-desktop")
})

test("a macOS build without Apple credentials is signed ad hoc, without the hardened runtime", async () => {
  const saved = { id: process.env.APPLE_ID, key: process.env.APPLE_API_KEY }
  delete process.env.APPLE_ID
  delete process.env.APPLE_API_KEY
  const module = await import("./electron-builder.config.ts?adhoc")
  const config = module.default as Configuration
  if (saved.id !== undefined) process.env.APPLE_ID = saved.id
  if (saved.key !== undefined) process.env.APPLE_API_KEY = saved.key

  expect(config.mac?.identity).toBe("-")
  expect(config.mac?.hardenedRuntime).toBe(false)
  expect(config.mac?.notarize).toBe(false)
  // source maps stay on the build machine
  expect(config.files).toContain("!out/**/*.map")
})

test("bundles the CLI outside the dev app archive", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "dev"
  const module = await import("./electron-builder.config.ts?cli-resource")
  const config = module.default as Configuration
  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.files).toContain("!resources/opencode-cli*")
  expect(config.extraResources).toContainEqual({
    from: "resources/",
    to: "",
    filter: ["opencode-cli*"],
  })
})

for (const channel of ["beta", "prod"] as const) {
  test(`does not bundle the CLI in ${channel} builds`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel
    const module = await import(`./electron-builder.config.ts?no-cli-resource=${channel}`)
    const config = module.default as Configuration
    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.extraResources).not.toContainEqual({
      from: "resources/",
      to: "",
      filter: ["opencode-cli*"],
    })
  })
}
