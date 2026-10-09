# KYA package manager manifests

This directory contains package-manager distribution files for
`@shield-agent/kya`.

| Manager | Path | Status | Install command |
|---------|------|--------|-----------------|
| Homebrew | [`homebrew/Formula/shield-kya.rb`](./homebrew/Formula/shield-kya.rb) | Live in `The-Pixel-Boys/homebrew-tap` | `brew install The-Pixel-Boys/tap/shield-kya` |
| Scoop | [`scoop/bucket/shield-kya.json`](./scoop/bucket/shield-kya.json) | Live in `The-Pixel-Boys/scoop-bucket` | `scoop install shield-kya` |
| WinGet | [`winget/manifests/t/The-Pixel-Boys/ShieldKYA/0.19.0/`](./winget/manifests/t/The-Pixel-Boys/ShieldKYA/0.19.0/) | Manifest prepared; needs Windows installer asset before PR to `microsoft/winget-pkgs` | `winget install The-Pixel-Boys.ShieldKYA` |

## Updating after a release

1. Bump the version and SHA256 in `homebrew/Formula/shield-kya.rb` and push to
   `The-Pixel-Boys/homebrew-tap`.
2. Bump the version and SHA256 in `scoop/bucket/shield-kya.json` and push to
   `The-Pixel-Boys/scoop-bucket`.
3. For WinGet, build/attach a Windows installer, update the manifest, and open a
   PR against `microsoft/winget-pkgs`.
