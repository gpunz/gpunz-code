import { describe, expect, test } from "bun:test"
import { agentConfig, agentContext, agentEnv, ASK_BEFORE, ASK_BEFORE_EDIT, PROVIDER_ID } from "./agent-config"

describe("the agent's configuration for a rented model", () => {
  const config = agentConfig({
    bridgeUrl: "http://127.0.0.1:50123/v1",
    bridgeKey: "local-secret",
    modelId: "chat-qwen38",
    modelName: "Qwen 3.8 27B",
    contextTokens: 65_536,
  })

  test("one provider — the local bridge — and that model as both models", () => {
    expect(Object.keys(config.provider)).toEqual([PROVIDER_ID])
    expect(config.enabled_providers).toEqual([PROVIDER_ID])
    expect(config.provider[PROVIDER_ID]?.options).toEqual({ baseURL: "http://127.0.0.1:50123/v1", apiKey: "local-secret" })
    expect(config.model).toBe("gpunz/chat-qwen38")
    expect(config.small_model).toBe("gpunz/chat-qwen38")
    expect(config.autoupdate).toBe(false)
    expect(config.share).toBe("disabled")
  })

  test("keeps the agent's window below the server's, which cuts a longer prompt without an error", () => {
    const limit = config.provider[PROVIDER_ID]?.models["chat-qwen38"]?.limit
    expect(limit?.context).toBe(agentContext(65_536))
    expect(agentContext(65_536)).toBeLessThan(65_536 - 4_000)
    expect(agentContext(65_536)).toBeGreaterThan(55_000)
    expect(agentContext(262_144)).toBeLessThan(262_144)
    // a tiny window still leaves room to work
    expect(agentContext(4_096)).toBe(8_192)
    expect(config.compaction.auto).toBe(true)
  })

  test("asks before commands that delete or rewrite history, allows the rest", () => {
    const bash = config.permission.bash as Record<string, string>
    expect(bash["*"]).toBe("allow")
    for (const pattern of ["rm *", "Remove-Item *", "del *", "git push *", "git reset --hard*", "sudo *"]) {
      expect(bash[pattern]).toBe("ask")
    }
    expect(ASK_BEFORE.length).toBeGreaterThan(20)
    // the catch-all comes first: later, more specific rules win
    expect(Object.keys(bash)[0]).toBe("*")
  })

  test("asks before a wrapped or piped command and before writing files that run later", () => {
    const bash = config.permission.bash as Record<string, string>
    for (const pattern of ["bash -c *", "powershell *", "cmd /c *", "sh", "iex *", "find * -delete*", "git -C * push*"]) {
      expect(bash[pattern]).toBe("ask")
    }
    const edit = config.permission.edit as Record<string, string>
    expect(Object.keys(edit)[0]).toBe("*")
    expect(edit["*"]).toBe("allow")
    for (const pattern of ["*.opencode/*", "*opencode.json", "*.git/*", "*.vscode/tasks.json"]) {
      expect(edit[pattern]).toBe("ask")
    }
    expect(ASK_BEFORE_EDIT.length).toBeGreaterThan(5)
  })

  test("reaches the agent server as inline config, with the upstream model catalogue and updater off", () => {
    const env = agentEnv(config)
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}").model).toBe("gpunz/chat-qwen38")
    expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1")
  })
})
