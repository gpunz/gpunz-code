import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

// gpu.nz Code: our own ids, names and artifacts (the same ids as src/main/index.ts)
const APP_IDS = {
  dev: "nz.gpu.code.dev",
  beta: "nz.gpu.code.beta",
  prod: "nz.gpu.code",
} as const
const PRODUCT = { dev: "gpu.nz Code Dev", beta: "gpu.nz Code Beta", prod: "gpu.nz Code" } as const
// macOS: signed and notarized only where the Apple credentials are present (a release build); a local build is not
const APPLE = Boolean(process.env.APPLE_ID || process.env.APPLE_API_KEY)

const getBase = (appId: string): Configuration => ({
  artifactName: "gpunz-code-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.opencode.desktop" becomes
  // "ai.opencode.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  // source maps stay on the build machine (they are what turns a reported stack back into source lines)
  files: ["out/**/*", "!out/**/*.map", "resources/**/*", "!resources/opencode-cli*"],
  // the installed program is not a general-purpose Node: no ELECTRON_RUN_AS_NODE, NODE_OPTIONS or --inspect, and
  // code is loaded from the packed archive only — another program of the same user cannot turn the app (which holds
  // the account key) into its own script runner. The agent server runs as a utility process and needs none of them.
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
  },
  extraResources: [
    ...(channel === "dev"
      ? [
          {
            from: "resources/",
            to: "",
            filter: ["opencode-cli*"],
          },
        ]
      : []),
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    // No Developer ID yet: the app is signed ad hoc («-»), which is what lets it start at all on Apple Silicon. The
    // hardened runtime needs a real identity (with an ad hoc one it rejects Electron's own frameworks), so it comes
    // on together with the Apple credentials.
    identity: APPLE ? undefined : "-",
    hardenedRuntime: APPLE,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: APPLE,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: APPLE,
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  // The Microsoft Store build (`--win appx`): the Store signs the package itself, so this is the way to a signed
  // Windows build without buying a certificate. Identity values come from the app's page in Partner Center
  // (Product identity); without them the build is a local test package. See GPUNZ.md «Microsoft Store».
  appx: {
    applicationId: "GpunzCode",
    displayName: "gpu.nz Code",
    identityName: process.env.GPUNZ_STORE_IDENTITY || "gpunz.Code",
    publisher: process.env.GPUNZ_STORE_PUBLISHER || "CN=gpu.nz (test)",
    publisherDisplayName: process.env.GPUNZ_STORE_PUBLISHER_NAME || "gpu.nz",
    backgroundColor: "#060d17",
    languages: ["ru-RU", "en-US"],
    // file and registry writes are not redirected into the package: see resources/appx/appxmanifest.xml
    capabilities: ["runFullTrust", "unvirtualizedResources"],
    customManifestPath: "appx/appxmanifest.xml",
    minVersion: "10.0.19041.0",
    maxVersionTested: "10.0.26100.0",
    artifactName: "gpunz-code-store-${arch}.${ext}",
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig(): Configuration {
  const appId = APP_IDS[channel]
  return {
    ...getBase(appId),
    appId,
    // our own feed: the build writes latest*.yml for it (signed afterwards, see GPUNZ.md «Releases»). Nothing is
    // uploaded by the build itself (`--publish never`).
    publish: { provider: "generic", url: "https://gpu.nz/downloads/code" },
    productName: PRODUCT[channel],
    deb: { fpm: [metainfoFpm(appId)] },
    rpm: { packageName: channel === "prod" ? "gpunz-code" : `gpunz-code-${channel}`, fpm: [metainfoFpm(appId)] },
  }
}

export default getConfig()
