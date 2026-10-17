# KYA report design

Design rules for the OSS report (the HTML rendered by `kya receipt`, `kya start`,
and `kya certify --open`). The hosted console has its own direction doc
(`docs/product/frontend-design-direction.md`); this file governs the local
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

Corollaries for anyone changing this report:

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
- Conditional rendering on data *inside* a panel (hide a table with zero
  rows, show counts only when non-zero) stays fine; conditional rendering of
  the feature itself does not.

## Layout contract

- Sidebar nav lists zones and major panels; every `id`-ed panel is reachable
  by anchor.
- Overview zone: Certify hero + KPI tiles + analytics. System zone:
  Capabilities first, then gateway, wired hosts, sandboxes, OpenShell, ORR,
  alerts, OTel export, tools.
- Zones never render as bare whitespace: with no panels a zone shows a hint
  that names the activation path (the Capabilities panel normally guarantees
  the System zone is never empty).
