# Golden cross-test vectors

Fixed test-only ed25519 keypair + canonical evidence-bundle fixtures with
expected signatures and sha256 digests. **These files are copied into the
Java monorepo's verifier tests** (parallel plan) — the bundle format is a
hard cross-repo contract. Never edit the expected files by hand; regenerate
with `KYA_WRITE_GOLDEN=1 pnpm vitest run test/golden-vectors.test.ts` and
review the diff. The key here is TEST-ONLY; it signs nothing real.
