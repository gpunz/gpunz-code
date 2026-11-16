import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId = channel === "prod" ? "nz.gpu.code" : `nz.gpu.code.${channel}`
const productName =
  channel === "prod" ? "gpu.nz Code" : `gpu.nz Code ${channel.charAt(0).toUpperCase() + channel.slice(1)}`
const summary = `AI coding agent on a rented GPU${channel !== "prod" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="nz.gpu">
    <name>gpu.nz</name>
  </developer>

  <description>
    <p>
      gpu.nz Code is a coding agent that runs on your computer and talks to an open model on a GPU server rented by
      the minute at gpu.nz. Built on OpenCode (MIT); not affiliated with the OpenCode team.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="homepage">https://gpu.nz</url>
</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)
console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
