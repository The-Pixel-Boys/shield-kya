# Shield Agent and KYA Trademark Policy

Owner of the marks: MFR Limited ("we", "us").

Last updated: 2026-10-18

## Why this policy exists

KYA is open source. We want people to use it, fork it, build on it and write about it.

Our names and logos are different. They tell users who made something and who stands behind
it. If anyone could ship a modified build, or run a hosted service, under our names, users
could not tell what is ours and what is not. That hurts users and it hurts the project.

This policy explains what you can do with our marks without asking, what needs conditions,
and what needs a written agreement. When in doubt, ask us. We usually say yes.

## 1. Scope

### 1.1 Marks covered

This policy covers these names and marks, in any spelling, capitalization or language, and
anything confusingly similar to them (together, "the Marks"):

- **Shield Agent** (including the domain `shield-agent.com`)
- **Shield KYA**
- **KYA** and **Know Your Agent**, when used for software, services or proof related to AI
  agents
- the command name **`kya`** when presented as the name of a product
- **Shield Verified** and any badge, seal or mark that says or suggests a Shield Agent or KYA
  verification
- **KYA Certified**, **kya certify** and similar certification claims
- **kya-action** (the GitHub Action)
- our logos, including the logo shipped as `assets/logo.svg` in the KYA package, and any
  future logo or badge artwork we publish

We use the Marks as unregistered marks to identify our software and services.

Current status: not registered.

### 1.2 The open source license does not grant trademark rights

The KYA client (npm package `@shield-agent/kya`, repository `The-Pixel-Boys/shield-kya`) is
released under the MIT License (see [LICENSE](LICENSE)). That license covers copyright in the
code. It does not grant any right to use the Marks. Your rights in the code are unchanged by
this policy. This policy only covers the Marks.

## 2. Always allowed, no need to ask

You may use the Marks, in plain text, to refer truthfully to our products. For example:

- Saying your tool "works with KYA", "supports Shield KYA" or "integrates with Shield Agent".
- Naming an integration in a descriptive way, such as "Integration for Shield KYA", as long as
  your own name comes first or is clearly separate.
- Writing reviews, tutorials, blog posts, talks, videos, courses and books about KYA.
- Comparing KYA with other products, as long as the comparison is accurate.
- Making accurate factual statements, such as "this project uses KYA 0.30".
- Redistributing **unmodified** official releases under their official names, with the
  license and notices intact.
- Using the Marks in academic work and news reporting.

Rules for all of the above:

- Use only as much of the Mark as you need. Plain text is enough. Do not use our logo.
- Do not suggest that we sponsor, endorse or certify you or your product.
- Do not make the Mark the most prominent part of your product name, page or listing.

## 3. Allowed with conditions

Community projects, plugins, integrations, user groups and meetups are welcome. You may use the
Marks in their description if you follow all of these conditions:

- State clearly that the project is **unofficial** and **not endorsed by Shield Agent**. A line
  such as "This is a community project. It is not affiliated with or endorsed by Shield Agent."
  is enough.
- Do not imply that we built, maintain, support or approve it.
- Do not use our logo, badge artwork or anything that looks like them.
- Do not use a name, color scheme or design that makes your project look like ours.
- Use the Mark as a description ("for KYA"), not as your project's own name ("KYA Pro").

We may ask you to change or stop a use that confuses users, even if it meets these conditions.

## 4. Not allowed without a written agreement

The following need a signed written agreement with us. Email us first.

### 4.1 Forks and modified builds

You may fork and modify the code under the MIT License. If you distribute a modified version,
you must **rename it**. A modified build must not use the Marks in its name, package name,
command name presented as a product, logo, icon or store listing.

You may say, accurately, that your fork is "based on KYA" or "derived from Shield KYA", in
plain text and not in the product name.

Minor changes needed only to package an official release for a distribution (for example a
Linux distribution or package manager) are fine if the package clearly points to the official
upstream and does not change behavior. Ask us if unsure.

### 4.2 Hosted, managed and marketplace offerings

You may not offer KYA, or any product derived from it, as a hosted, managed, software as a
service, cloud or marketplace offering **under a name or listing that uses or contains the
Marks**. This includes offerings named or described as "KYA as a service", "Managed KYA",
"Shield KYA on (a platform)" or similar.

You may run the code for yourself or for your clients under your own name, with an accurate
plain-text statement such as "built on the open source KYA project", as long as you do not
present the offering as official.

### 4.3 Domain names, package names and accounts

You may not register or use domain names, package names (npm, PyPI, crates, Maven, container
registries, app and extension marketplaces), organization names, social media handles or
similar identifiers that contain the Marks in a way that suggests they are official or come
from us. Examples: `kya-official.dev`, `shieldagent-cloud.com`, `@kya/core` on a registry
where we do not own the scope.

### 4.4 Verification and certification claims

You may not issue, display or sell any badge, seal, certificate, report or statement that uses
"Shield Verified", "KYA Certified", "KYA verified" or anything similar, except by linking to or
embedding the badge images and the verify endpoint we serve, unchanged. See section 5.

### 4.5 Merchandise

You may not make or sell merchandise (clothing, stickers, mugs and so on) bearing the Marks.
Contact us for event or community merchandise. We are happy to help.

## 5. How badges and certification work

- **Only we show verification marks.** "Shield Verified" status and badges are shown only by
  the badge images and the verify endpoint that we serve from our own domains. You may link to or
  embed those images and that endpoint as we serve them. You may not show the marks anywhere else, recreate them, or imitate
  them.
- **What a green badge means.** We show the green "Shield Verified" badge only for an evidence
  bundle signed with the signing key of an active hosted Shield Agent workspace. Green ties the
  bundle to a hosted account. It does not mean that we checked the legal identity of the person
  or company behind that account, and it is not a third-party audit.
- **The open source client does not issue verification marks.** `kya certify` produces a local
  gap report. `kya certify --sign` produces an evidence bundle signed with a key generated on
  your own machine. The badge images and the verify endpoint we serve show such a bundle with a grey "self-signed" badge, never a
  green one. A self-signed bundle proves the bundle was not changed and that the same key signed
  it. It does **not** prove who you are, and it is not a verification by us.
- **Shared receipts are self-reported.** A Certify status shown on a shared receipt page is
  labelled as self-reported by the CLI, not verified by Shield Agent.
- **Presenting an open source, self-signed bundle as "KYA verified", "Shield Verified", "KYA
  Certified" or similar is a misuse of the Marks.** So is building a service that issues
  look-alike badges or certificates based on the open source output.

You may say accurately, for example, "We ran `kya certify` and passed 28 of 31 requirements
(self-reported)."

## 6. Enforcement

- **Friendly first.** Most problems are honest mistakes. We will usually contact you, explain
  the issue and give you reasonable time to fix it.
- **Takedowns when needed.** If a use is confusing, misleading or harmful, or is not fixed, we
  may send complaints to registries and platforms, including npm, GitHub, PyPI, container
  registries, app and extension marketplaces, domain registrars and hosting providers.
- **Legal basis.** We may rely on unfair competition and passing off or equivalent laws as well
  as trademark law.
- **Permission can be revoked.** Any permission under this policy, or given by us in writing,
  can be withdrawn if the use stops complying, or if it starts to confuse users.
- **All rights reserved.** We reserve all rights not expressly granted here. Not acting on one
  use does not waive our rights against that use or any other.
- **Changes.** We may update this policy. The current version is published at
  https://github.com/The-Pixel-Boys/shield-kya/blob/main/TRADEMARKS.md

## 7. What protects the names without registration

The Marks are not registered. We rely on these instead:

- **A dated record of first use.** Public npm releases of `@shield-agent/kya` and the public
  git history of `The-Pixel-Boys/shield-kya` show when each name was first used.
- **Consistent use.** We use the same names for the same products, everywhere.
- **This policy.** It tells everyone what is allowed and what is not.
- **Defensive names.** We control the `@shield-agent` npm scope, the `The-Pixel-Boys` GitHub
  organization and the `shield-agent.com` domain, and may add more. The `The-Pixel-Boys`
  organization is the account that hosts the code. It is not the owner of the Marks.
- **Platform complaint routes.** Registries and hosting providers (npm, GitHub, PyPI,
  marketplaces and others) have their own processes for confusing or impersonating names. We
  will use those first.

None of this guarantees a particular outcome in any given case.

## 8. Contact

Questions, permission requests and misuse reports: **it@shield-agent.com**

Please include what you want to do, where, and a link or mockup if you have one.
