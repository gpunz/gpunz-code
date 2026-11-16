import { useLanguage } from "@opencode-ai/app"
import { createEffect, createMemo, createSignal, For, Match, on, onMount, Show, Switch } from "solid-js"
import type { GpunzEstimate, GpunzModel, GpunzSession, PickMode, SessionError } from "../../main/gpunz/types"
import { gzDuration, gzMoney, gzT, type GzKey } from "./i18n"
import { openHelp } from "./help"
import { estimateOf, loadEstimate, loadModels, setGateDismissed, useGpunz, useNow } from "./store"
import "./gpunz.css"

type T = ReturnType<typeof gzT>

/** The brand mark: a 3×3 grid of GPU cores, one running hot. */
export function Mark(props: { size?: number }) {
  const cells = [
    [1, 1],
    [9, 1],
    [17, 1],
    [1, 9],
    [17, 9],
    [1, 17],
    [9, 17],
    [17, 17],
  ]
  return (
    <svg class="gz-mark" viewBox="0 0 24 24" width={props.size ?? 18} height={props.size ?? 18} aria-hidden="true">
      <For each={cells}>{([x, y]) => <rect x={x} y={y} width="6" height="6" rx="1.4" />}</For>
      <rect class="gz-core" x="9" y="9" width="6" height="6" rx="1.4" />
    </svg>
  )
}

export function Brand() {
  return (
    <span class="gz-brand">
      <Mark />
      <span>
        gpu<b>.</b>
        <i>nz</i> <em>Code</em>
      </span>
    </span>
  )
}

/**
 * gpu.nz Code's own window: sign in → model → launch. Shown before the agent's interface exists, and over it when
 * the model is gone (`overlay`), where it can be put aside to read old sessions without a model.
 */
export function GpunzGate(props: { overlay?: boolean }) {
  const { state } = useGpunz()
  const language = useLanguage()
  const t = createMemo(() => gzT(language.locale()))
  const session = () => state()?.session

  return (
    <div class="gz gz-gate" data-overlay={props.overlay ? "" : undefined}>
      <div class="gz-drag" />
      <div class="gz-top">
        <Brand />
        <div class="gz-spacer" />
        <Show when={state()?.app.newVersion}>
          {(v) => (
            <button class="gz-btn gz-btn-update" onClick={() => void window.api.gpunz.open("download")}>
              {t()("help.update.new", { v: v() })}
            </button>
          )}
        </Show>
        <button class="gz-btn gz-btn-ghost" onClick={() => openHelp()}>
          {t()("help.open")}
        </button>
        <Show when={state()?.signedIn && (props.overlay || session()?.phase === "idle")}>
          <button
            class="gz-btn gz-btn-ghost"
            onClick={() => {
              setGateDismissed(true)
              // before any model was launched there is no agent yet: start it with nothing rented
              if (!props.overlay) void window.api.gpunz.openAgent()
            }}
          >
            {t()("models.without")}
          </button>
        </Show>
        <Show when={state()?.signedIn && state()?.account}>
          {(account) => (
            <>
              <span class="gz-balance">
                {t()("account.balance")}
                <b>{gzMoney(account().availableKop, account().currency, language.locale())}</b>
                <button class="gz-btn" onClick={() => void window.api.gpunz.open("topup")}>
                  {t()("models.topupPlain")}
                </button>
              </span>
              <Show when={account().email}>
                <span class="gz-faint" style={{ "font-size": "12.5px" }}>
                  {account().email}
                </span>
              </Show>
              <button class="gz-btn gz-btn-ghost" onClick={() => void window.api.gpunz.logout()}>
                {t()("account.logout")}
              </button>
            </>
          )}
        </Show>
      </div>
      <div class="gz-scroll">
        <div class="gz-center">
          <Switch>
            <Match when={!state()}>
              <Mark size={56} />
            </Match>
            <Match when={!state()?.signedIn}>
              <Login t={t()} />
            </Match>
            <Match when={session()?.phase === "launching" && session()}>
              {(s) => <Launching t={t()} session={s() as Extract<GpunzSession, { phase: "launching" }>} />}
            </Match>
            <Match when={session()?.phase === "ready"}>
              <div class="gz-launch">
                <Cores percent={100} />
                <h2 class="gz-h2">{t()("launch.agent")}</h2>
              </div>
            </Match>
            <Match when={true}>
              <Models t={t()} />
            </Match>
          </Switch>
        </div>
      </div>
    </div>
  )
}

function Login(props: { t: T }) {
  const { state } = useGpunz()
  const login = () => state()?.login
  return (
    <div class="gz-login">
      <Show
        when={login()}
        fallback={
          <>
            <div class="gz-hero-mark">
              <Mark size={64} />
            </div>
            <h1 class="gz-h1">{props.t("login.title")}</h1>
            <p class="gz-lead">{props.t("login.lead")}</p>
            <button class="gz-btn gz-btn-primary gz-btn-lg" onClick={() => void window.api.gpunz.login()}>
              {props.t("login.button")}
            </button>
            <button class="gz-link" style={{ "margin-top": "14px" }} onClick={() => void window.api.gpunz.open("signup")}>
              {props.t("login.signup")}
            </button>
            <ul class="gz-points">
              <li>{props.t("login.point.1")}</li>
              <li>{props.t("login.point.2")}</li>
              <li>{props.t("login.point.3")}</li>
            </ul>
          </>
        }
      >
        {(l) => (
          <>
            <h1 class="gz-h1">{props.t("login.wait.title")}</h1>
            <p class="gz-lead">{props.t("login.wait.lead")}</p>
            <div class="gz-code" aria-label={props.t("login.wait.code")}>
              {l().userCode}
            </div>
            <div class="gz-row" style={{ "margin-top": "18px" }}>
              <button class="gz-btn" onClick={() => window.open(l().url, "_blank")}>
                {props.t("login.wait.open")}
              </button>
              <button class="gz-btn gz-btn-ghost" onClick={() => void window.api.gpunz.cancelLogin()}>
                {props.t("login.wait.cancel")}
              </button>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

const MODES: PickMode[] = ["balanced", "fast", "cheap"]
const IDLE_OPTIONS = [15, 30, 60, null] as const

function errorText(t: T, e: SessionError, locale: string | undefined): string {
  switch (e.kind) {
    case "insufficient_funds":
      return e.needKop
        ? t("error.insufficient_funds.need", { sum: gzMoney(e.needKop, e.currency, locale) })
        : t("error.insufficient_funds")
    case "unknown":
      return t("error.unknown", { message: e.message })
    default:
      return t(`error.${e.kind}` as GzKey)
  }
}

function Models(props: { t: T }) {
  const { state, models } = useGpunz()
  const language = useLanguage()
  const locale = () => language.locale()
  const [mode, setMode] = createSignal<PickMode>(state()?.settings.pickMode ?? "balanced")
  const [selected, setSelected] = createSignal<string | null>(state()?.settings.lastModelId ?? null)
  const [busy, setBusy] = createSignal(false)
  /** the person's own model: what is typed, and the name the estimate on screen is for */
  const [customDraft, setCustomDraft] = createSignal(state()?.settings.customModels[0] ?? "")
  const [customName, setCustomName] = createSignal<string | null>(
    state()?.settings.lastModelId === CUSTOM_ID ? (state()?.settings.customModels[0] ?? null) : null,
  )
  const applyCustom = (name = customDraft()) => {
    const v = name.trim()
    if (!v) return
    setCustomDraft(v)
    setCustomName(v)
    setSelected(CUSTOM_ID)
    void loadEstimate(CUSTOM_ID, mode(), v, true)
  }

  onMount(() => void loadModels())
  createEffect(() => {
    const list = models()
    if (!list?.length) return
    if (!selected() || (selected() !== CUSTOM_ID && !list.some((m) => m.id === selected())))
      setSelected(list[0]?.id ?? null)
    if (selected() === CUSTOM_ID && !customName()) setSelected(list[0]?.id ?? null)
    const m = mode()
    for (const model of list) void loadEstimate(model.id, m)
    const own = customName()
    if (own) void loadEstimate(CUSTOM_ID, m, own)
  })
  // a launch that ended (an error, a stop) frees the button again
  createEffect(on(() => state()?.session.phase, () => setBusy(false)))

  const account = () => state()?.account ?? null
  const currency = () => account()?.currency ?? "RUB"
  const est = createMemo(() => {
    const id = selected()
    if (!id) return undefined
    const e = estimateOf(id, mode(), id === CUSTOM_ID ? customName() : null)
    return typeof e === "object" ? e : undefined
  })
  /** catalogue prices are market rubles; a dollar account sees them at the service's rate */
  const inAccount = (kopRub: number, e?: GpunzEstimate) =>
    currency() === "USD" && e?.usdRub ? Math.round((kopRub / e.usdRub) * 100) : kopRub
  const price = (kopRub: number, e?: GpunzEstimate) => gzMoney(inAccount(kopRub, e), currency(), locale())
  /** the service asks for an hour of the server on the balance before it starts one */
  const shortKop = createMemo(() => {
    const e = est()
    const a = account()
    if (!e?.available || !a) return 0
    return Math.max(0, inAccount(e.priceKopH + e.launchTrafficKop, e) - a.availableKop)
  })
  const runwayHours = createMemo(() => {
    const e = est()
    const a = account()
    if (!e?.available || !a || e.priceKopH <= 0) return null
    const h = (a.availableKop - inAccount(e.launchTrafficKop, e)) / inAccount(e.priceKopH, e)
    return h >= 1 ? h : null
  })
  const error = () => {
    const s = state()?.session
    return s?.phase === "idle" ? s.lastError : undefined
  }

  const launch = () => {
    const id = selected()
    if (!id || busy()) return
    setBusy(true)
    void window.api.gpunz.launch(id, mode(), id === CUSTOM_ID ? customName() : null)
  }
  const topup = () => {
    const short = shortKop()
    // a round sum that covers the launch: at least 100 ₽, to the next hundred
    const rub = currency() === "RUB" ? Math.max(100, Math.ceil(short / 100 / 100) * 100) : undefined
    void window.api.gpunz.open("topup", rub)
  }

  return (
    <div class="gz-models">
      <Show when={error()}>
        {(e) => (
          <div class="gz-banner" classList={{ "gz-banner-crit": e().kind === "hosts_failed" || e().kind === "unknown" }}>
            <span>{errorText(props.t, e(), locale())}</span>
            <span class="gz-row">
              <Show when={e().kind === "insufficient_funds" || e().kind === "balance_zero"}>
                <button class="gz-btn gz-btn-primary" onClick={topup}>
                  {props.t("models.topupPlain")}
                </button>
              </Show>
              <Show when={e().kind === "email_not_verified"}>
                <button class="gz-btn" onClick={() => void window.api.gpunz.open("console")}>
                  {props.t("account.console")}
                </button>
              </Show>
              <Show when={e().kind === "hosts_failed" || e().kind === "unknown"}>
                <button
                  class="gz-btn"
                  onClick={() => (e().kind === "unknown" ? openHelp("bug") : void window.api.gpunz.open("support"))}
                >
                  {props.t("error.report")}
                </button>
              </Show>
            </span>
          </div>
        )}
      </Show>
      <div class="gz-models-head">
        <div>
          <h1 class="gz-h2">{props.t("models.title")}</h1>
          <p class="gz-lead" style={{ "margin-top": "6px", "font-size": "14px" }}>
            {props.t("models.lead")}
          </p>
        </div>
        <div style={{ display: "grid", gap: "6px", "justify-items": "end" }}>
          <div class="gz-seg" role="group">
            <For each={MODES}>
              {(m) => (
                <button aria-pressed={mode() === m} onClick={() => setMode(m)}>
                  {props.t(`models.mode.${m}` as GzKey)}
                </button>
              )}
            </For>
          </div>
          <span class="gz-faint" style={{ "font-size": "12px" }}>
            {props.t(`models.mode.hint.${mode()}` as GzKey)}
          </span>
        </div>
      </div>
      <div class="gz-cards">
        <For each={models() ?? []}>
          {(model) => (
            <ModelCard
              t={props.t}
              model={model}
              mode={mode()}
              selected={selected() === model.id}
              onSelect={() => setSelected(model.id)}
              price={price}
              locale={locale()}
            />
          )}
        </For>
        <Show when={models() !== null}>
          <div
            class="gz-card gz-card-custom"
            role="button"
            tabindex="0"
            aria-pressed={selected() === CUSTOM_ID}
            onClick={() => customName() && setSelected(CUSTOM_ID)}
          >
            <div class="gz-card-title">{props.t("models.custom.title")}</div>
            <p class="gz-card-desc" style={{ "min-height": "0" }}>
              {props.t("models.custom.lead")}
            </p>
            <form
              class="gz-custom-form"
              onSubmit={(e) => {
                e.preventDefault()
                applyCustom()
              }}
            >
              <input
                class="gz-input gz-mono"
                type="text"
                spellcheck={false}
                autocomplete="off"
                placeholder={props.t("models.custom.placeholder")}
                value={customDraft()}
                onInput={(e) => setCustomDraft(e.currentTarget.value)}
                onClick={(e) => e.stopPropagation()}
              />
              <button class="gz-btn" type="submit" disabled={!customDraft().trim()} onClick={(e) => e.stopPropagation()}>
                {props.t("models.custom.check")}
              </button>
            </form>
            <Show when={(state()?.settings.customModels.length ?? 0) > 0}>
              <div class="gz-chips">
                <For each={state()?.settings.customModels ?? []}>
                  {(name) => (
                    <button
                      class="gz-chip gz-mono"
                      onClick={(e) => {
                        e.stopPropagation()
                        applyCustom(name)
                      }}
                    >
                      {name}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show when={customName()}>
              {(name) => (
                <CustomEstimate
                  t={props.t}
                  locale={locale()}
                  estimate={estimateOf(CUSTOM_ID, mode(), name())}
                  price={price}
                />
              )}
            </Show>
          </div>
        </Show>
        <Show when={models() === null}>
          <div class="gz-card" style={{ cursor: "default" }}>
            <div class="gz-skeleton" style={{ width: "50%" }} />
            <div class="gz-skeleton" style={{ width: "90%" }} />
            <div class="gz-skeleton" style={{ width: "70%" }} />
          </div>
        </Show>
      </div>
      <div class="gz-footer">
        <div class="gz-idle">
          <label>
            {props.t("models.idle.label")}
            <select
              class="gz-select"
              value={String(state()?.settings.idleStopMinutes ?? "never")}
              onChange={(e) => {
                const v = e.currentTarget.value
                void window.api.gpunz.setSettings({ idleStopMinutes: v === "never" ? null : Number(v) })
              }}
            >
              <For each={IDLE_OPTIONS}>
                {(o) => <option value={String(o ?? "never")}>{props.t(`models.idle.${o ?? "never"}` as GzKey)}</option>}
              </For>
            </select>
          </label>
          <span class="gz-faint" style={{ "font-size": "12px" }}>
            {props.t("models.idle.hint")}
          </span>
        </div>
        <div class="gz-launch-side">
          <Show
            when={shortKop() > 0}
            fallback={
              <>
                <Show when={runwayHours()}>
                  {(h) => (
                    <span class="gz-muted" style={{ "font-size": "12.5px" }}>
                      {props.t("models.runway", {
                        h: h().toLocaleString(locale()?.startsWith("ru") ? "ru-RU" : "en-US", {
                          maximumFractionDigits: h() >= 10 ? 0 : 1,
                        }),
                      })}
                    </span>
                  )}
                </Show>
                <button
                  class="gz-btn gz-btn-primary gz-btn-lg"
                  disabled={busy() || !est()?.available}
                  onClick={launch}
                >
                  {est()?.available
                    ? props.t("models.launchFor", { sum: price(est()?.priceKopH ?? 0, est()) })
                    : props.t("models.launch")}
                </button>
              </>
            }
          >
            <span class="gz-muted" style={{ "font-size": "12.5px", "max-width": "30ch", "text-align": "right" }}>
              {props.t("models.needFunds")}
            </span>
            <button class="gz-btn gz-btn-primary gz-btn-lg" onClick={topup}>
              {props.t("models.topup", { sum: gzMoney(Math.max(shortKop(), currency() === "RUB" ? 10_000 : 0), currency(), locale(), 0) })}
            </button>
          </Show>
        </div>
      </div>
    </div>
  )
}

function ModelCard(props: {
  t: T
  model: GpunzModel
  mode: PickMode
  selected: boolean
  onSelect: () => void
  price: (kopRub: number, e?: GpunzEstimate) => string
  locale: string | undefined
}) {
  const estimate = () => estimateOf(props.model.id, props.mode)
  const descKey = `models.desc.${props.model.id}` as GzKey
  return (
    <button class="gz-card" aria-pressed={props.selected} onClick={props.onSelect}>
      <div class="gz-card-title">
        {props.model.name}
        <Show when={props.model.uncensored}>
          <span class="gz-tag gz-tag-hot">{props.t("models.uncensored")}</span>
        </Show>
        <Show when={props.model.verified}>
          <span class="gz-tag gz-tag-ok">{props.t("models.verified")}</span>
        </Show>
      </div>
      <p class="gz-card-desc">{props.t(descKey)}</p>
      <div class="gz-est">
        <Switch>
          <Match when={estimate() === undefined || estimate() === "loading"}>
            <span class="gz-faint" style={{ "font-size": "12.5px" }}>
              {props.t("models.est.loading")}
            </span>
            <div class="gz-skeleton" style={{ width: "60%" }} />
          </Match>
          <Match when={estimate() === "error" || (typeof estimate() === "object" && !(estimate() as GpunzEstimate).available)}>
            <span class="gz-muted" style={{ "font-size": "12.5px" }}>
              {props.t("models.est.none")}
            </span>
          </Match>
          <Match when={typeof estimate() === "object" && (estimate() as GpunzEstimate)}>
            {(e) => (
              <>
                <div class="gz-est-main">
                  <span class="gz-price">
                    {props.price(e().priceKopH, e())}
                    <small>{props.t("models.est.perHour")}</small>
                  </span>
                  <span class="gz-gpu">{e().gpuName}</span>
                  <Show when={e().country}>
                    <span class="gz-faint gz-mono" style={{ "font-size": "12px" }}>
                      {e().country}
                    </span>
                  </Show>
                </div>
                <div class="gz-facts">
                  <span>
                    {e().tokensPerSecond
                      ? props.t("models.est.speed", { n: e().tokensPerSecond ?? 0 })
                      : props.t("models.est.speedUnknown")}
                  </span>
                  <Show when={e().contextTokens}>
                    <span>{props.t("models.est.context", { n: Math.round((e().contextTokens ?? 0) / 1024) })}</span>
                  </Show>
                  <Show when={e().launchMinutes}>
                    {(lm) => <span>{props.t("models.est.launch", { a: lm().low, b: lm().high })}</span>}
                  </Show>
                  <Show when={e().launchTrafficKop >= 100}>
                    <span>{props.t("models.est.traffic", { sum: props.price(e().launchTrafficKop, e()) })}</span>
                  </Show>
                </div>
              </>
            )}
          </Match>
        </Switch>
      </div>
    </button>
  )
}

const CUSTOM_ID = "custom"

/** What the person's own model needs and costs, or why it cannot be launched. */
function CustomEstimate(props: {
  t: T
  locale: string | undefined
  estimate: GpunzEstimate | "loading" | "error" | undefined
  price: (kopRub: number, e?: GpunzEstimate) => string
}) {
  const e = () => (typeof props.estimate === "object" ? props.estimate : null)
  return (
    <div class="gz-est">
      <Switch>
        <Match when={props.estimate === undefined || props.estimate === "loading"}>
          <span class="gz-faint" style={{ "font-size": "12.5px" }}>
            {props.t("models.est.loading")}
          </span>
          <div class="gz-skeleton" style={{ width: "60%" }} />
        </Match>
        <Match when={props.estimate === "error"}>
          <span class="gz-muted" style={{ "font-size": "12.5px" }}>
            {props.t("error.network")}
          </span>
        </Match>
        <Match when={e()?.problem === "unknown_model"}>
          <span class="gz-problem">{props.t("models.custom.unknown")}</span>
        </Match>
        <Match when={e()?.problem === "too_big"}>
          <span class="gz-problem">{props.t("models.custom.tooBig")}</span>
        </Match>
        <Match when={e()?.problem === "invalid_name"}>
          <span class="gz-problem">{props.t("models.custom.invalid")}</span>
        </Match>
        <Match when={e() && !e()?.available}>
          <span class="gz-muted" style={{ "font-size": "12.5px" }}>
            {props.t("models.est.none")}
          </span>
        </Match>
        <Match when={e()?.available && e()}>
          {(est) => (
            <>
              <div class="gz-est-main">
                <span class="gz-price">
                  {props.price(est().priceKopH, est())}
                  <small>{props.t("models.est.perHour")}</small>
                </span>
                <span class="gz-gpu">{est().gpuName}</span>
                <Show when={est().country}>
                  <span class="gz-faint gz-mono" style={{ "font-size": "12px" }}>
                    {est().country}
                  </span>
                </Show>
              </div>
              <div class="gz-facts">
                <Show when={est().sizeGb && est().minVramGb}>
                  <span>
                    {props.t("models.custom.size", {
                      gb: (est().sizeGb ?? 0).toLocaleString(props.locale?.startsWith("ru") ? "ru-RU" : "en-US"),
                      vram: est().minVramGb ?? 0,
                    })}
                  </span>
                </Show>
                <Show when={est().contextTokens}>
                  <span>{props.t("models.est.context", { n: Math.round((est().contextTokens ?? 0) / 1024) })}</span>
                </Show>
                <Show when={est().launchMinutes}>
                  {(lm) => <span>{props.t("models.est.launch", { a: lm().low, b: lm().high })}</span>}
                </Show>
              </div>
              <span class="gz-faint" style={{ "font-size": "12px" }}>
                {props.t("models.custom.untested")}
              </span>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}

/** The mark as a progress picture: the eight outer cores light up with the launch, the middle one runs hot. */
function Cores(props: { percent: number }) {
  // clockwise from the top-left corner
  const order: [number, number][] = [
    [1, 1],
    [9, 1],
    [17, 1],
    [17, 9],
    [17, 17],
    [9, 17],
    [1, 17],
    [1, 9],
  ]
  const lit = () => Math.min(8, Math.floor((props.percent / 100) * 8))
  return (
    <svg class="gz-cores" viewBox="0 0 24 24" aria-hidden="true">
      <For each={order}>
        {([x, y], i) => (
          <rect
            x={x}
            y={y}
            width="6"
            height="6"
            rx="1.4"
            classList={{ on: i() < lit(), now: i() === lit() && props.percent < 100 }}
          />
        )}
      </For>
      <rect class="core" classList={{ hot: props.percent >= 100 }} x="9" y="9" width="6" height="6" rx="1.4" />
    </svg>
  )
}

function Launching(props: { t: T; session: Extract<GpunzSession, { phase: "launching" }> }) {
  const language = useLanguage()
  const s = () => props.session
  const eta = () => {
    switch (s().etaKind) {
      case "minutes":
        return s().etaMinutes ? props.t("launch.eta.minutes", { n: s().etaMinutes ?? 0 }) : ""
      case "soon":
        return props.t("launch.eta.soon")
      case "bit":
        return props.t("launch.eta.bit")
      case "over":
        return props.t("launch.eta.over")
      default:
        return ""
    }
  }
  const stages = () =>
    s().stages.length
      ? s().stages.filter((x) => x.id !== "ready")
      : [{ id: "pick", state: "active" as const, percent: 0 }]
  return (
    <div class="gz-launch">
      <Cores percent={s().percent} />
      <h2 class="gz-h2">{props.t("launch.title", { model: s().modelName })}</h2>
      <Show when={s().gpuName && s().priceKopH}>
        <p class="gz-lead gz-mono" style={{ "font-size": "13px", "margin-top": "8px" }}>
          {props.t("launch.server", {
            gpu: s().gpuName ?? "",
            sum: gzMoney(s().priceKopH ?? 0, s().currency, language.locale()),
          })}
        </p>
      </Show>
      <div class="gz-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={s().percent}>
        <div style={{ width: `${Math.max(2, s().percent)}%` }} />
      </div>
      <div class="gz-bar-meta">
        <span class="gz-mono">{s().percent}%</span>
        <span>{eta()}</span>
      </div>
      <ul class="gz-stages">
        <For each={stages()}>
          {(stage) => (
            <li data-state={stage.state}>
              <span class="gz-dot" />
              <span>{props.t(`launch.stage.${stage.id}` as GzKey)}</span>
              <span />
            </li>
          )}
        </For>
      </ul>
      <Show when={s().note}>
        {(note) => (
          <div class="gz-note">
            {note().kind === "host_failed"
              ? props.t("launch.note.host_failed", { n: (note() as { attempt: number }).attempt + 1 })
              : props.t("launch.note.host_lost")}
          </div>
        )}
      </Show>
      <Show when={s().usualMinutes}>
        {(u) => <p class="gz-hint">{props.t("launch.usual", { a: u().low, b: u().high })}</p>}
      </Show>
      <button class="gz-btn gz-btn-ghost" style={{ "margin-top": "14px" }} onClick={() => void window.api.gpunz.stop()}>
        {props.t("launch.cancel")}
      </button>
    </div>
  )
}

/** For countdowns elsewhere: «через 4 мин». */
export function useCountdown(until: () => number | null) {
  const now = useNow()
  const language = useLanguage()
  return () => {
    const at = until()
    return at ? gzDuration(at - now(), language.locale()) : null
  }
}
