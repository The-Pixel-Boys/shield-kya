# Security policy

## Reporting a vulnerability

Email **it@shield-agent.com**. This address is the primary security contact for the
project and reaches the maintainer directly.

Please include:

- the affected version (`npm view @shield-agent/kya version` and your installed version)
- the component (gate, policy, report server, importers, exporters)
- steps to reproduce, or a proof of concept
- the impact you see (policy bypass, data exposure, crash)

We aim to acknowledge within 72 hours and to keep you updated until the issue is fixed.
Please do not open a public issue for a vulnerability before we have shipped a fix.

## Scope

See `.oss-scanner/threat_model.md` for what we consider in scope, how the project is
exercised, and how we rate severity.

## Supported versions

Only the latest published version of `@shield-agent/kya` on npm receives security fixes.
Run `npm i -g @shield-agent/kya@latest` to update.
