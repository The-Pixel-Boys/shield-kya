# kya certify - EU AI Act crosswalk

Maps the 30 requirements of the [Agent Trust Baseline](../catalog/agent-trust-baseline-v0.json)
(evaluated by `kya certify`) onto the EU AI Act, Regulation (EU) 2024/1689.

Who this serves: deployers of AI agents who must produce evidence for a
conformity assessment or answer a customer's AI Act questionnaire. `kya
certify` already produces a machine-checked gap report against the baseline;
this crosswalk tells you which article each requirement's evidence speaks to.
The machine-readable form of this mapping is
[`src/certify/eu-ai-act-map.json`](../src/certify/eu-ai-act-map.json).

This is an alignment guide. It is not legal advice, not a conformity
assessment, and not a claim that Shield KYA makes your system compliant.

## Art. 9 - Risk management system

A continuous, iterative risk-management process. The baseline contributes the
enforcement and measurement side: policies that bound risk, and repeated
evidence that they hold.

| Requirement | Rationale |
|---|---|
| DP-02 | High-stakes writes never silently allowed in hold mode is a concrete risk-reduction measure. |
| SEC-01 | An enforcing gate (not observe-only) is the risk control actually operating. |
| SEC-04 | Security posture not red shows identified risks are tracked and mitigated. |
| SEC-05 | Refusing to allow unclassifiable tools is fail-closed risk handling. |
| SAFE-01 | Never-events never allowed is the strongest baseline risk mitigation. |
| SAFE-02 | Sandbox isolation for high-risk execution is a technical risk measure. |
| SAFE-03 | Overall ORR not red is the periodic risk picture the risk-management system reviews. |
| SAFE-05 | Bounded retries close the bypass loop on blocked actions. |
| REL-02 | Bounded unknown-tool rate measures how well the control surface is understood. |
| SOC-01 | An acceptable-use policy is the documented intent the risk system enforces. |

## Art. 10 - Data and data governance

Data governance for training data is a provider duty; the deployer-side slice
the baseline covers is governance of the data the agent touches and stores.

| Requirement | Rationale |
|---|---|
| DP-04 | Redaction by construction keeps raw arguments and secrets out of evidence stores. |
| DP-05 | Bounded, known retention is the data-minimization and storage-limitation practice. |
| SOC-04 | Data-processing terms define the lawful basis for user data the agent handles. |

## Art. 11 + Annex IV - Technical documentation

Documentation drawn up before placing on the market and kept up to date. KYA
evidence feeds Annex IV sections on system behavior and risk measures; it does
not replace the provider's documentation file.

| Requirement | Rationale |
|---|---|
| ACC-03 | A current ORR report is deployer-generated technical evidence of the system's observed behavior. |

## Art. 12 - Record-keeping

Automatic logging over the system's lifetime, with traceability of events.
This is the baseline's strongest article: the trail exists to satisfy it.

| Requirement | Rationale |
|---|---|
| DP-01 | Intercepted, recorded tool calls are the automatic event log Art. 12 requires. |
| DP-05 | A known retention window addresses Art. 12(2) appropriate retention of logs. |
| REL-01 | Recent trail activity proves the recording pipeline is live, not configured-but-dead. |
| REL-05 | Activity receipts are the per-run record outputs of the log. |
| ACC-01 | Session identity on every event makes the log traceable to an operator or run. |
| ACC-02 | Project attribution ties log events to the deployment context. |

## Art. 13 - Transparency and provision of information to deployers

Sufficiently clear information so deployers can interpret outputs and use the
system appropriately.

| Requirement | Rationale |
|---|---|
| SOC-03 | Disclosure of third-party models and providers is core transparency to users. |
| SOC-05 | A published escalation contact tells users what happens and who answers when the agent causes harm. |

## Art. 14 - Human oversight

The system must allow effective human oversight, including intervention and
override. The baseline's hold/approve path is the oversight mechanism.

| Requirement | Rationale |
|---|---|
| DP-02 | High-stakes writes route to a human instead of executing autonomously. |
| DP-03 | Shell execution in hold mode requires human approval, an override point. |
| SEC-03 | An exercised REQUIRE_APPROVE path proves the human gate is reachable, not decorative. |
| SAFE-01 | Never-events are outside human discretion entirely; oversight cannot approve them away. |
| SAFE-04 | Destructive operations requiring approval is the canonical Art. 14 intervention mechanism. |
| SAFE-05 | Bounded retries stop the agent from routing around the human's decision. |
| ACC-01 | Session identity lets an overseer trace any event back to a run. |
| ACC-05 | A named, reachable policy owner is the accountable human behind oversight. |
| SOC-05 | A published escalation contact extends oversight to affected third parties. |

## Art. 15 - Accuracy, robustness and cybersecurity

Appropriate levels of accuracy, robustness, and cybersecurity. The baseline
covers the cybersecurity and resilience slice for agent tool use.

| Requirement | Rationale |
|---|---|
| DP-03 | Not silently allowing shell execution reduces the attack surface. |
| DP-04 | Never persisting secrets to evidence stores is a cybersecurity control on the tooling itself. |
| SEC-01 | An enforcing gate is the active cybersecurity control for agent actions. |
| SEC-02 | An exercised deny path proves the control works against real traffic. |
| SEC-04 | A green or amber security posture tracks cybersecurity weaknesses over time. |
| SEC-05 | Fail-closed on unknown tools is resilience against unclassified behavior. |
| SAFE-02 | Sandbox isolation limits blast radius of high-risk execution. |
| REL-02 | A bounded unknown-tool rate is an accuracy measure of classification. |
| REL-04 | A supervised evidence pipeline keeps security-relevant logging resilient to failure. |

## Art. 26 - Obligations of deployers of high-risk AI systems

Deployer duties: use per instructions, ensure human oversight, keep logs,
monitor operation. These apply to the deployer, so most baseline attest
requirements land here.

| Requirement | Rationale |
|---|---|
| DP-01 | Retained tool-call records support the deployer's duty to keep logs under their control. |
| ACC-04 | Cost showback supports the deployer's operational monitoring of the system. |
| ACC-05 | A named policy owner operationalizes the deployer's oversight responsibility. |
| SOC-01 | An acceptable-use policy is the deployer defining instructed use. |
| SOC-02 | An incident runbook is the deployer's side of monitoring and reacting to malfunction. |
| SOC-04 | Data-processing terms are the deployer's governance of input data under their control. |

## Art. 72 - Post-market monitoring

Systematic collection and review of experience from real-world use. The
baseline's freshness and continuity checks map here.

| Requirement | Rationale |
|---|---|
| SEC-02 | Observed DENY events are real-world operating experience fed back into policy. |
| SAFE-03 | A current overall ORR rating is the periodic review of in-use behavior. |
| REL-03 | Fresh (30-day) ORR evidence makes monitoring continuous rather than one-off. |
| REL-04 | Supervised pipeline continuity keeps the monitoring channel itself alive. |
| ACC-03 | A 90-day-old-or-newer ORR report bounds how stale monitoring evidence may be. |
| SOC-02 | The incident runbook is the response half of the monitoring plan. |

## Reverse table: requirement to articles

| Requirement | Domain | Articles |
|---|---|---|
| DP-01 | data-privacy | art-12, art-26 |
| DP-02 | data-privacy | art-14, art-9 |
| DP-03 | data-privacy | art-14, art-15 |
| DP-04 | data-privacy | art-10, art-15 |
| DP-05 | data-privacy | art-10, art-12 |
| SEC-01 | security | art-15, art-9 |
| SEC-02 | security | art-15, art-72 |
| SEC-03 | security | art-14 |
| SEC-04 | security | art-15, art-9 |
| SEC-05 | security | art-9, art-15 |
| SAFE-01 | safety | art-9, art-14 |
| SAFE-02 | safety | art-15, art-9 |
| SAFE-03 | safety | art-9, art-72 |
| SAFE-04 | safety | art-14 |
| SAFE-05 | safety | art-14, art-9 |
| REL-01 | reliability | art-12 |
| REL-02 | reliability | art-15, art-9 |
| REL-03 | reliability | art-72 |
| REL-04 | reliability | art-72, art-15 |
| REL-05 | reliability | art-12 |
| ACC-01 | accountability | art-12, art-14 |
| ACC-02 | accountability | art-12 |
| ACC-03 | accountability | art-11, art-72 |
| ACC-04 | accountability | art-26 |
| ACC-05 | accountability | art-14, art-26 |
| SOC-01 | society | art-26, art-9 |
| SOC-02 | society | art-72, art-26 |
| SOC-03 | society | art-13 |
| SOC-04 | society | art-10, art-26 |
| SOC-05 | society | art-14, art-13 |

## Scope note

- KYA supplies **technical evidence and logging**: trail events, receipts,
  ORR reports, attestations, signed evidence bundles. That is input to a
  conformity assessment, not the assessment itself.
- Whether your agent system is **high-risk** under Annex III is the
  deployer's classification call, with their counsel. KYA does not classify.
- Many obligations above bind the **provider** of the AI system, not the
  deployer. If you only deploy a third-party model, several articles are
  satisfied (or not) upstream; the baseline covers the slice under your
  control.
- A `pass` row in `kya certify` means local evidence exists for a baseline
  requirement. It is never a statement that an article of Regulation (EU)
  2024/1689 is satisfied.
- Articles not in this crosswalk (registration, conformity procedures,
  incident reporting under Art. 73, fundamental-rights impact assessment)
  have no baseline requirement today; their absence is scope, not coverage.
