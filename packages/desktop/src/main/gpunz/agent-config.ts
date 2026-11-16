/**
 * The agent's configuration for one rented model: a single provider — the local bridge — and nothing else.
 * Passed to the agent server as OPENCODE_CONFIG_CONTENT (inline, above the user's own files), so the user's
 * opencode.json, AGENTS.md, skills and MCP servers still apply; only the model provider is ours.
 */
export const PROVIDER_ID = "gpunz"

/** Tokens kept free below the server's window: it cuts a longer prompt without an error, the agent must compact first. */
export function agentContext(serverContext: number): number {
  return Math.max(8_192, Math.floor(serverContext * 0.94) - 2_048)
}

/**
 * Commands the agent asks about before running, whatever else is allowed: the ones that delete, overwrite history
 * or reach outside the project. Seen on the first live run (2026-11-12): the agent removed a file it no longer
 * needed with `Remove-Item` and nobody was asked. Everything else runs without a prompt, as upstream does, and a
 * path outside the project is asked about by the agent's own default.
 */
export const ASK_BEFORE = [
  "rm *",
  "rmdir *",
  "unlink *",
  "shred *",
  "del *",
  "erase *",
  "rd *",
  "Remove-Item *",
  "ri *",
  "Clear-Content *",
  "git push *",
  "git reset --hard*",
  "git clean *",
  "git checkout -- *",
  "git restore *",
  "git branch -D *",
  "sudo *",
  "su *",
  "shutdown *",
  "reboot*",
  "mkfs*",
  "dd *",
  "format *",
  "diskpart*",
  "reg delete *",
  "chmod -R *",
  "chown -R *",
  "npm publish*",
  "docker system prune*",
  "kubectl delete *",
  "terraform destroy*",
  "DROP *",
  // the same things behind a wrapper or another name: the pattern is matched against each command as it is
  // written, so `bash -c "rm -rf x"` or `/bin/rm x` would otherwise pass as «bash» and «/bin/rm»
  "bash -c *",
  "sh -c *",
  "zsh -c *",
  "cmd /c *",
  "cmd.exe /c *",
  "powershell *",
  "powershell.exe *",
  "pwsh *",
  "wsl *",
  "xargs *",
  "env *",
  "command *",
  "nohup *",
  "/bin/rm *",
  "/usr/bin/rm *",
  "find * -delete*",
  "find * -exec *",
  "truncate *",
  "git rm *",
  "git -C * push*",
  "git -c * push*",
  "git checkout -f*",
  "git checkout .",
  "git switch -f*",
  "git stash drop*",
  "git stash clear*",
  "git reflog expire*",
  "git gc --prune*",
  "rsync * --delete*",
  "robocopy * /MIR*",
  "docker rm *",
  "docker volume rm*",
  "Remove-ItemProperty *",
  "Format-Volume*",
  "Clear-Disk*",
  "Stop-Computer*",
  "Restart-Computer*",
  "Stop-Process *",
  "taskkill *",
  "reg add *",
  "schtasks *",
  "icacls *",
  "takeown *",
  // a script piped into a shell or evaluated: code from the network runs with nobody having read it
  "sh",
  "bash",
  "zsh",
  "iex",
  "iex *",
  "Invoke-Expression*",
] as const

/**
 * Files the agent asks about before it writes them, inside the project too: the ones that are run by something
 * later without anybody asking — the agent's own plugins and config (a plugin or an MCP server written there
 * starts with the next session), git hooks, editor tasks. Everything else in the project is edited freely.
 */
export const ASK_BEFORE_EDIT = [
  "*.opencode/*",
  "*opencode.json",
  "*opencode.jsonc",
  "*.git/*",
  "*.husky/*",
  "*.vscode/tasks.json",
  "*.vscode/launch.json",
  "*.claude/settings*.json",
] as const

export function agentConfig(input: {
  bridgeUrl: string
  bridgeKey: string
  modelId: string
  modelName: string
  contextTokens: number
}) {
  const ref = `${PROVIDER_ID}/${input.modelId}`
  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "gpu.nz",
        options: { baseURL: input.bridgeUrl, apiKey: input.bridgeKey },
        models: {
          [input.modelId]: {
            name: input.modelName,
            tool_call: true,
            limit: { context: agentContext(input.contextTokens), output: 8_192 },
          },
        },
      },
    },
    model: ref,
    small_model: ref,
    enabled_providers: [PROVIDER_ID],
    autoupdate: false,
    share: "disabled",
    compaction: { auto: true },
    permission: {
      bash: { "*": "allow", ...Object.fromEntries(ASK_BEFORE.map((pattern) => [pattern, "ask"])) },
      edit: { "*": "allow", ...Object.fromEntries(ASK_BEFORE_EDIT.map((pattern) => [pattern, "ask"])) },
    },
  }
}

/** Environment of the agent server besides the config itself. */
export function agentEnv(config: ReturnType<typeof agentConfig>): Record<string, string> {
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    // the model list comes from us; nothing to fetch from the upstream catalogue
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  }
}
