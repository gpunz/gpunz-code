import { useLanguage } from "@opencode-ai/app"
import type { UpdaterState } from "@opencode-ai/app/updater"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js"
import { Portal } from "solid-js/web"
import type { FeedbackKind } from "../../main/gpunz/types"
import { type GzKey, gzT } from "./i18n"
import { useGpunz } from "./store"
import "./gpunz.css"

/**
 * «Помощь и обратная связь»: one window for writing to us (a problem, an idea, a word about the app) and for what a
 * person looks for in an «About» box — the version, updates, whether error reports are sent, where the source is.
 * Opened from the gate's top bar, the session panel, the Help menu and the command palette.
 */
const [helpKind, setHelpKind] = createSignal<FeedbackKind | null>(null)
export const openHelp = (kind: FeedbackKind = "bug") => setHelpKind(kind)

const KINDS: FeedbackKind[] = ["bug", "idea", "feedback"]
type Status = "idle" | "sending" | "network" | "invalid"

export function GpunzHelp(props: { updater: () => UpdaterState }) {
  const { state } = useGpunz()
  const language = useLanguage()
  const t = createMemo(() => gzT(language.locale()))
  const [kind, setKind] = createSignal<FeedbackKind>("bug")
  const [message, setMessage] = createSignal("")
  const [email, setEmail] = createSignal("")
  const [includeLog, setIncludeLog] = createSignal(true)
  const [status, setStatus] = createSignal<Status>("idle")
  const [sentId, setSentId] = createSignal<string | null>(null)
  const [checked, setChecked] = createSignal(false)
  let field: HTMLTextAreaElement | undefined

  const open = () => helpKind() !== null
  const close = () => setHelpKind(null)
  const account = () => state()?.account ?? null
  const app = () => state()?.app

  // every opening starts clean, on the tab it was asked for; what was typed and not sent is kept
  createEffect(
    on(helpKind, (k) => {
      if (!k) return
      setKind(k)
      setStatus("idle")
      setSentId(null)
      setChecked(false)
      queueMicrotask(() => field?.focus())
    }),
  )

  const onKey = (event: KeyboardEvent) => {
    if (open() && event.key === "Escape") {
      event.stopPropagation()
      close()
    }
  }
  window.addEventListener("keydown", onKey, true)
  onCleanup(() => window.removeEventListener("keydown", onKey, true))

  const canSend = () => message().trim().length >= 3 && status() !== "sending"
  async function send() {
    if (!canSend()) return
    setStatus("sending")
    const res = await window.api.gpunz
      .feedback({
        kind: kind(),
        message: message().trim(),
        email: email().trim() || null,
        includeLog: kind() === "bug" && includeLog(),
      })
      .catch(() => ({ ok: false as const, reason: "network" as const }))
    if (res.ok) {
      setSentId(res.id)
      setMessage("")
      setStatus("idle")
      return
    }
    setStatus(res.reason)
  }

  const updateText = (): string => {
    const u = props.updater()
    switch (u.status) {
      case "checking":
        return t()("help.update.checking")
      case "downloading":
        return t()("help.update.downloading", { v: u.version })
      case "ready":
      case "installing":
        return t()("help.update.ready", { v: u.version })
      case "up-to-date":
        return t()("help.update.latest")
      case "error":
        return t()("help.update.error")
      default:
        return ""
    }
  }

  return (
    <Show when={open()}>
      <Portal>
        <div
          class="gz gz-modal"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) close()
          }}
        >
          <div class="gz-dialog" role="dialog" aria-modal="true" aria-label={t()("help.title")}>
            <header class="gz-dialog-head">
              <h2 class="gz-h2">{t()("help.title")}</h2>
              <button class="gz-btn gz-btn-ghost gz-x" aria-label={t()("help.close")} onClick={close}>
                ×
              </button>
            </header>

            <Show
              when={!sentId()}
              fallback={
                <div class="gz-sent" role="status">
                  <b>{t()("help.sent.title")}</b>
                  <span class="gz-muted">
                    {t()(account()?.email || email().trim() ? "help.sent.lead" : "help.sent.leadNoMail", { id: sentId() ?? "" })}
                  </span>
                  <div class="gz-row">
                    <button class="gz-btn" onClick={() => setSentId(null)}>
                      {t()("help.sent.more")}
                    </button>
                    <button class="gz-btn gz-btn-ghost" onClick={close}>
                      {t()("help.close")}
                    </button>
                  </div>
                </div>
              }
            >
              <div class="gz-seg" role="group">
                <For each={KINDS}>
                  {(k) => (
                    <button aria-pressed={kind() === k} onClick={() => setKind(k)}>
                      {t()(`help.kind.${k}` as GzKey)}
                    </button>
                  )}
                </For>
              </div>
              <textarea
                ref={field}
                class="gz-input gz-textarea"
                rows={6}
                maxLength={8000}
                placeholder={t()(`help.placeholder.${kind()}` as GzKey)}
                value={message()}
                onInput={(e) => setMessage(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send()
                }}
              />
              <Show
                when={account()?.email}
                fallback={
                  <input
                    class="gz-input"
                    type="email"
                    autocomplete="email"
                    spellcheck={false}
                    placeholder={t()("help.email")}
                    value={email()}
                    onInput={(e) => setEmail(e.currentTarget.value)}
                  />
                }
              >
                {(mail) => (
                  <span class="gz-faint" style={{ "font-size": "12.5px" }}>
                    {t()("help.replyTo", { email: mail() })}
                  </span>
                )}
              </Show>
              <Show when={kind() === "bug"}>
                <label class="gz-check">
                  <input type="checkbox" checked={includeLog()} onChange={(e) => setIncludeLog(e.currentTarget.checked)} />
                  <span>
                    {t()("help.log")}
                    <small>{t()("help.log.hint")}</small>
                  </span>
                </label>
              </Show>
              <Show when={status() === "network" || status() === "invalid"}>
                <span class="gz-problem" role="alert">
                  {t()(status() === "invalid" ? "help.error.invalid" : "help.error.network")}
                </span>
              </Show>
              <div class="gz-row">
                <button class="gz-btn gz-btn-primary" disabled={!canSend()} onClick={() => void send()}>
                  {t()(status() === "sending" ? "help.sending" : "help.send")}
                </button>
                <button class="gz-btn gz-btn-ghost" onClick={close}>
                  {t()("help.cancel")}
                </button>
              </div>
            </Show>

            <footer class="gz-help-foot">
              <div class="gz-help-line">
                <span>
                  gpu.nz Code <b class="gz-mono">{app()?.version ?? ""}</b>
                </span>
                <Switch>
                  <Match when={app()?.fromStore}>
                    <span class="gz-faint">{t()("help.update.store")}</span>
                  </Match>
                  <Match when={app()?.selfUpdating}>
                    <span class="gz-faint">{updateText()}</span>
                    <Show
                      when={props.updater().status === "ready"}
                      fallback={
                        <button
                          class="gz-link"
                          disabled={props.updater().status === "checking" || props.updater().status === "downloading"}
                          onClick={() => void window.api.updater.check()}
                        >
                          {t()("help.update.check")}
                        </button>
                      }
                    >
                      <button class="gz-link gz-accent" onClick={() => void window.api.updater.install()}>
                        {t()("help.update.install")}
                      </button>
                    </Show>
                  </Match>
                  <Match when={app()?.newVersion}>
                    {(v) => (
                      <>
                        <span class="gz-faint">{t()("help.update.new", { v: v() })}</span>
                        <button class="gz-link gz-accent" onClick={() => void window.api.gpunz.open("download")}>
                          {t()("help.update.download")}
                        </button>
                      </>
                    )}
                  </Match>
                  <Match when={true}>
                    <Show when={checked()}>
                      <span class="gz-faint">{t()("help.update.latest")}</span>
                    </Show>
                    <button
                      class="gz-link"
                      onClick={() => void window.api.gpunz.checkVersion().then(() => setChecked(true))}
                    >
                      {t()("help.update.check")}
                    </button>
                  </Match>
                </Switch>
              </div>
              <label class="gz-check">
                <input
                  type="checkbox"
                  checked={state()?.settings.errorReports ?? true}
                  onChange={(e) => void window.api.gpunz.setSettings({ errorReports: e.currentTarget.checked })}
                />
                <span>
                  {t()("help.reports")}
                  <small>{t()("help.reports.hint")}</small>
                </span>
              </label>
              <div class="gz-help-links">
                <button class="gz-link" onClick={() => void window.api.gpunz.open("docs")}>
                  {t()("help.link.docs")}
                </button>
                <button class="gz-link" onClick={() => void window.api.gpunz.open("support")}>
                  {t()("help.link.support")}
                </button>
                <button class="gz-link" onClick={() => void window.api.gpunz.open("github")}>
                  {t()("help.link.source")}
                </button>
                <button class="gz-link" onClick={() => void window.api.exportDebugLogs()}>
                  {t()("help.link.logs")}
                </button>
              </div>
            </footer>
          </div>
        </div>
      </Portal>
    </Show>
  )
}
