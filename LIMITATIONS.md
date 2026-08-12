# Known limitations

- Offline `eval-tool --offline` is a **sample** policy surface for demo. Production uses a real control plane (local free or hosted).
- Sole PEP is Shield KYA evaluate/approve path. Scanners and ORR CLI are **evidence only**, not a second PEP.
- Not a model/content moderation product (use guardrails for dialog rails).
- Not a multi-language in-process runtime like MS Agent Governance Toolkit.
- Not general OPA replacement for infra policy.
- Enterprise multi-tenant density, private registries, and curated pins are separate from the solo `npx` path.
