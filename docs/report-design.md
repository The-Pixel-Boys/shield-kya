# KYA report design

Design rules for the OSS report (the HTML rendered by `kya receipt`, `kya start`,
and `kya certify --open`). The hosted console has its own direction doc
(`docs/product/frontend-design-direction.md`); this file covers the local
report.

## The dashboard is the documentation

The report must be self-explanatory and self-service at all times. A user
never has to read CLI help, repo docs, or a changelog to learn what the
install can do. Two rules follow:

1. **Every capability is indexed, always.** The Capabilities panel
   (`capabilitiesPanel` in `src/receipt/render-receipt.ts`) renders on every
   report, including a fresh install with zero events. Each row names the
   capability, says what it does, shows live (green) vs available (neutral)
   status, and gives the exact command or config key that turns it on. When a
   new capability ships, its row is added here in the same change.

2. **Feature panels render empty states, not nothing.** A panel for a
   supported feature never returns an empty string because its data is absent.
   It renders an empty state that says what the feature does and the command
   to activate it (see the OpenShell, Alerts, OTel export, Import, and
   Discovery panels). Hiding a feature until it has data makes it
   undiscoverable: users do not search docs to find features, they scroll the
   dashboard. The one exception is purely derived detail (per-session filters,
   paginated feeds), which has nothing meaningful to say until the parent
   dataset exists.

Rules that follow for anyone changing this report:

- Adding an integration, backend, exporter, or detector: add the Capabilities
  row, give the feature panel an always-on empty state with the activation
  command, and cover both in tests (`test/report-capabilities-panel.test.ts`
  and the feature's own panel test).
- Status on the Capabilities panel is derived from fields already on
  `ReceiptModel`. The panel never runs its own probes or IO: loaders probe,
  panels render.
- Empty states name a concrete next action ("Import an export with
  `kya import --from openshell FILE`"), never a dead end ("No data").
- A self-test button must work with zero configuration. When nothing is
  configured yet, the action runs against an ephemeral loopback sink (the
  notify test delivers through the real sender to a temporary receiver; the
  OTel test exports to a temporary collector), records the outcome where the
  panel reads it, and names the config key that makes it real. Erroring with
  "not configured" is a dead end and is not allowed.
- Expensive boards run themselves. A report that is produced by a CLI command
  the user has to discover (ORR is the precedent) is generated automatically
  when the live report starts and refreshes on a fixed cadence while it runs,
  so the menu item is populated on first open. The underlying CLI command
  stays the escape hatch, and a "run now" action covers the impatient case.
- A "run now" action must report what changed, not repeat the screen. The ORR
  re-run confirmation compares the new board against the previous one and says
  what moved ("red → green · 2 findings resolved") or states plainly "no
  change · still red · no go" with a timestamp, so an identical board is
  understood as the correct result, never as a broken button.
- Findings must be falsifiable (a reader must be able to check them). Every
  finding rendered in the report names
  its evidence (file:line, never the secret value), and heuristic probes
  exclude their own output directory, docs, tests, fixtures, and
  *.example/*.sample files (the ORR secrets probe is the contract: a
  "rotate credentials" finding nobody can check is worse than no finding).
- Conditional rendering on data *inside* a panel (hide a table with zero
  rows, show counts only when non-zero) stays fine; conditional rendering of
  the feature itself does not.

## Copy contract (ASD-STE100)

- All user-facing text follows Simplified Technical English: short sentences,
  one idea per sentence, active voice, simple approved words.
- No jargon without a plain explanation in place: "spending limit", not "cost
  budget gate"; "warning, not a block", not "soft gate"; "record" for trail,
  "decision" for verdict (ALLOW/DENY/REQUIRE_APPROVE stay, they are product
  terms).
- Every finding or status answers three questions in plain words: what is
  wrong, why it matters, what to do.
- This rule also covers README, docs, npmjs/GitHub descriptions, and the
  hosted website. The persisted owner rule lives in
  ~/dev/.remember/kya-public-style.md.

## Layout contract

- Sidebar nav lists zones and major panels; every `id`-ed panel is reachable
  by anchor.
- Zone switching is pure CSS in `receipt-css.ts` (`:target` + `body:has()`).
  Adding a zone or nav item means wiring all four rule groups: the default
  `display: none` hide list, the `#id:target` display rule, the
  `body:has(#id:target) #overview` override, and the nav highlight rule. A nav
  link without CSS wiring clicks to a no-op. `test/receipt-nav-css.test.ts`
  enforces this for every rendered nav link and zone, so the suite fails
  loudly when wiring is missed.
- Overview zone: Certify hero + KPI tiles + analytics. System zone:
  Capabilities first, then gateway, wired hosts, sandboxes, OpenShell, ORR,
  alerts, OTel export, tools.
- Zones never render as bare whitespace: with no panels a zone shows a hint
  that names the activation path (the Capabilities panel normally guarantees
  the System zone is never empty).

## Live-update contract

- The report never reloads the page on record (trail) activity. SSE
  (server-sent events) announces typed
  changes (`{"source":"trail"|"orr"|"action"}`); the client then refreshes in
  place: `POST /feed` swaps the feed + pagination for the current
  filter/page/search state, `POST /fragments` swaps only the containers whose
  HTML changed (`buildLiveFragments` in `render-receipt.ts` renders both the
  initial page and the refresh, so they cannot drift apart).
- Every live-updated container needs a stable id listed in the client's
  `FRAG_TARGETS` map. A new panel that renders live data must be added to
  `buildLiveFragments` and `FRAG_TARGETS`, or it will go stale until the next
  user action.
- Interactive elements inside swapped containers must not rely on per-element
  bindings: chip clicks are delegated on document, the pagination bar already
  delegates. After a swap the client reapplies pressed state from the
  query-param filter state.
- Updates are throttled (one `/fragments` per 2s), debounced (300ms), and
  deferred while the tab is hidden. A 401 stops auto-refresh and shows a
  restart banner: a dead token must never turn into a reload loop.
