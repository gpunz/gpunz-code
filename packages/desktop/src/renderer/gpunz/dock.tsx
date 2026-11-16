import { useLanguage } from "@opencode-ai/app"
import { createEffect, createMemo, createSignal, type JSX, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
import { Portal } from "solid-js/web"
import type { GpunzSession } from "../../main/gpunz/types"
import { GpunzGate } from "./gate"
import { openHelp } from "./help"
import { gzDuration, gzMoney, gzT } from "./i18n"
import { gateDismissed, setGateDismissed, useGpunz, useNow } from "./store"
import "./gpunz.css"

const IDLE_WARN_MS = 5 * 60_000
const LOW_BALANCE_MS = 15 * 60_000

/**
 * What stays on screen once the agent's interface is up: the pill with the rented model (and what it costs), the
 * warnings worth interrupting for (the server is about to be turned off, the balance is running out), and our gate
 * again when the model is gone.
 */
export function GpunzDock() {
  const { state } = useGpunz()
  const language = useLanguage()
  const locale = () => language.locale()
  const t = createMemo(() => gzT(locale()))
  const now = useNow()
  const [open, setOpen] = createSignal(false)
  const [confirmStop, setConfirmStop] = createSignal(false)
  /** «later» on the new-version notice: quiet until the next start or the next version */
  const [laterVersion, setLaterVersion] = createSignal<string | null>(null)
  /** the person put the gate aside to read old sessions without a model */
  const dismissed = gateDismissed
  const setDismissed = setGateDismissed

  const session = () => state()?.session
  const ready = () => (session()?.phase === "ready" ? (session() as Extract<GpunzSession, { phase: "ready" }>) : null)
  const account = () => state()?.account ?? null

  // a new model is up: the next time it goes away the gate shows again
  createEffect(
    on(
      () => session()?.phase,
      (phase) => {
        if (phase === "ready") setDismissed(false)
        if (phase !== "ready") {
          setOpen(false)
          setConfirmStop(false)
        }
      },
    ),
  )

  // the pill sits in the title bar's right slot (the agent's own mount point for such things); until the title bar
  // exists, or if it ever goes away, it floats in the corner instead
  const [slot, setSlot] = createSignal<HTMLElement | null>(null)
  onMount(() => {
    const sync = () => setSlot(document.getElementById("opencode-titlebar-right"))
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true })
    onCleanup(() => observer.disconnect())
  })
  const Slot = (p: { children: JSX.Element }) => (
    <Show when={slot()} fallback={<div class="gz gz-pill-float">{p.children}</div>}>
      {(el) => (
        <Portal mount={el()}>
          <span class="gz gz-pill-slot">{p.children}</span>
        </Portal>
      )}
    </Show>
  )

  // the panel closes on a click elsewhere and on Escape
  let root: HTMLDivElement | undefined
  const outside = (event: PointerEvent) => {
    const target = event.target as Element | null
    if (open() && root && !root.contains(target) && !target?.closest?.(".gz-pill")) setOpen(false)
  }
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") setOpen(false)
  }
  window.addEventListener("pointerdown", outside)
  window.addEventListener("keydown", escape)
  onCleanup(() => {
    window.removeEventListener("pointerdown", outside)
    window.removeEventListener("keydown", escape)
  })

  const idleLeft = () => {
    const r = ready()
    return r?.idleStopAt ? r.idleStopAt - now() : null
  }
  /** how long the balance lasts at this server's price */
  const runwayMs = () => {
    const r = ready()
    const a = account()
    if (!r || !a || r.priceKopH <= 0) return null
    return (a.availableKop / r.priceKopH) * 3_600_000
  }
  const money = (kop: number) => gzMoney(kop, ready()?.currency ?? account()?.currency ?? "RUB", locale())

  return (
    <>
      <Show when={session() && session()?.phase !== "ready" && !dismissed()}>
        <GpunzGate overlay />
      </Show>
      <div class="gz gz-pop" ref={root}>
        <Show when={ready()}>
          {(r) => (
            <>
              <Show when={r().toolsOk === false}>
                <div class="gz-toast" role="status">
                  <span>{t()("pill.noTools")}</span>
                </div>
              </Show>
              <Show when={(runwayMs() ?? Infinity) < LOW_BALANCE_MS}>
                <div class="gz-toast" role="status">
                  <span>{t()("pill.lowBalance", { t: gzDuration(runwayMs() ?? 0, locale()) })}</span>
                  <button class="gz-btn gz-btn-primary" onClick={() => void window.api.gpunz.open("topup")}>
                    {t()("pill.topup")}
                  </button>
                </div>
              </Show>
              <Show when={idleLeft() !== null && (idleLeft() ?? 0) < IDLE_WARN_MS}>
                <div class="gz-toast" role="status">
                  <span>{t()("pill.idle", { t: gzDuration(idleLeft() ?? 0, locale()) })}</span>
                  <button class="gz-btn" onClick={() => void window.api.gpunz.extend()}>
                    {t()("pill.extend")}
                  </button>
                </div>
              </Show>
              <Show when={open()}>
                <div class="gz-panel" role="dialog" aria-label={r().modelName}>
                  <h3>{r().modelName}</h3>
                  <div class="gz-kv">
                    <span>{t()("pill.spent", { gpu: r().gpuName })}</span>
                    <b>{t()("pill.perHour", { sum: money(r().priceKopH) })}</b>
                    <span>{t()("pill.uptime", { t: gzDuration(now() - r().startedAt, locale()) })}</span>
                    <b>{r().tokensPerSecond ? t()("pill.speed", { n: r().tokensPerSecond ?? 0 }) : "—"}</b>
                    <span>{t()("pill.context", { n: Math.round(r().contextTokens / 1024) })}</span>
                    <b>{r().country ?? ""}</b>
                    <Show when={account()}>
                      {(a) => (
                        <>
                          <span>{t()("account.balance")}</span>
                          <b>{money(a().availableKop)}</b>
                        </>
                      )}
                    </Show>
                    <Show when={idleLeft() !== null}>
                      <span>{t()("pill.idle", { t: gzDuration(idleLeft() ?? 0, locale()) })}</span>
                      <b>
                        <button class="gz-link" onClick={() => void window.api.gpunz.extend()}>
                          {t()("pill.extend")}
                        </button>
                      </b>
                    </Show>
                  </div>
                  <Show
                    when={confirmStop()}
                    fallback={
                      <div class="gz-panel-actions">
                        <button class="gz-btn" onClick={() => void window.api.gpunz.open("topup")}>
                          {t()("pill.topup")}
                        </button>
                        <button class="gz-btn gz-btn-danger" onClick={() => setConfirmStop(true)}>
                          {t()("pill.stop")}
                        </button>
                      </div>
                    }
                  >
                    <span class="gz-muted" style={{ "font-size": "12.5px" }}>
                      {t()("pill.stop.confirm")}
                    </span>
                    <div class="gz-panel-actions">
                      <button class="gz-btn" onClick={() => setConfirmStop(false)}>
                        {t()("pill.stop.no")}
                      </button>
                      <button
                        class="gz-btn gz-btn-danger"
                        onClick={() => {
                          setConfirmStop(false)
                          setOpen(false)
                          void window.api.gpunz.stop()
                        }}
                      >
                        {t()("pill.stop.yes")}
                      </button>
                    </div>
                  </Show>
                  <button
                    class="gz-link"
                    style={{ "font-size": "12.5px", "justify-self": "start" }}
                    onClick={() => {
                      setOpen(false)
                      openHelp()
                    }}
                  >
                    {t()("help.title")}
                  </button>
                </div>
              </Show>
            </>
          )}
        </Show>
        <Show when={state()?.app.newVersion && state()?.app.newVersion !== laterVersion() ? state()?.app.newVersion : null}>
          {(v) => (
            <div class="gz-toast" role="status">
              <span>{t()("help.update.new", { v: v() })}</span>
              <button class="gz-btn gz-btn-primary" onClick={() => void window.api.gpunz.open("download")}>
                {t()("help.update.download")}
              </button>
              <button class="gz-btn" onClick={() => setLaterVersion(v())}>
                {t()("help.update.dismiss")}
              </button>
            </div>
          )}
        </Show>
      </div>
      <Slot>
        <Switch>
          <Match when={ready()}>
            {(r) => (
              <button
                class="gz-pill"
                data-tone={r().recovering ? "warn" : "on"}
                aria-expanded={open()}
                onClick={() => setOpen(!open())}
              >
                <span class="gz-led" />
                <Show when={!r().recovering} fallback={<span>{t()("pill.recovering")}</span>}>
                  <span>{r().modelName}</span>
                  <span class="gz-sep">·</span>
                  <span class="gz-mono">{r().gpuName}</span>
                  <span class="gz-sep">·</span>
                  <span class="gz-mono">{t()("pill.perHour", { sum: money(r().priceKopH) })}</span>
                </Show>
              </button>
            )}
          </Match>
          <Match when={session()?.phase === "launching" && dismissed()}>
            <button class="gz-pill" data-tone="warn" onClick={() => setDismissed(false)}>
              <span class="gz-led" />
              <span>
                {t()("pill.launching", {
                  n: (session() as Extract<GpunzSession, { phase: "launching" }>).percent,
                })}
              </span>
            </button>
          </Match>
          <Match when={session()?.phase === "stopping"}>
            <span class="gz-pill" data-tone="off">
              <span class="gz-led" />
              <span>{t()("pill.stopping")}</span>
            </span>
          </Match>
          <Match when={dismissed()}>
            <button class="gz-pill" data-tone="off" onClick={() => setDismissed(false)}>
              <span class="gz-led" />
              <span>{t()("pill.noModel")}</span>
              <span class="gz-sep">·</span>
              <span style={{ color: "var(--gz-accent)" }}>{t()("pill.start")}</span>
            </button>
          </Match>
        </Switch>
      </Slot>
    </>
  )
}
