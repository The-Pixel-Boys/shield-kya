# WinGet manifest for Shield KYA

This directory holds a WinGet manifest for `The-Pixel-Boys.ShieldKYA`.

## Status

The manifest is schema-complete but **requires a Windows installer asset** before
it can be submitted to `microsoft/winget-pkgs`. KYA is distributed as an npm
package; WinGet needs a real installer (`.exe`, `.msi`, `.zip` portable, or MSIX).

## Required next step

1. Build or attach a Windows installer to the GitHub release:
   `https://github.com/The-Pixel-Boys/shield-kya/releases/tag/v0.19.0`
   Suggested asset name: `ShieldKYA-0.19.0.exe`
2. Replace `PLACEHOLDER_SHA256` in
   `manifests/t/The-Pixel-Boys/ShieldKYA/0.19.0/The-Pixel-Boys.ShieldKYA.installer.yaml`
   with the SHA256 of the installer.
3. Validate locally with `wingetvalidate` from the winget-pkgs repo or the
   `wingetcreate` tool.

## Submit to winget-pkgs

Fork `microsoft/winget-pkgs`, copy the `manifests/t/The-Pixel-Boys/ShieldKYA/0.19.0`
folder into your fork at the same path, then open a pull request:

```bash
# After forking microsoft/winget-pkgs and cloning it locally
cp -R packaging/winget/manifests/t/The-Pixel-Boys \
  /path/to/winget-pkgs/manifests/t/
cd /path/to/winget-pkgs
git checkout -b add-the-pixel-boys-shield-kya-0.19.0
git add manifests/t/The-Pixel-Boys/ShieldKYA/0.19.0
git commit -m "Add The-Pixel-Boys.ShieldKYA version 0.19.0"
git push origin add-the-pixel-boys-shield-kya-0.19.0
gh pr create --repo microsoft/winget-pkgs \
  --title "New version: The-Pixel-Boys.ShieldKYA version 0.19.0" \
  --body "- [ ] Have you signed the CLA?\n- [ ] Have you checked that there aren't other open pull requests for the same manifest?\n- [ ] Have you validated your manifest locally with wingetvalidate?"
```

## Notes

- The manifest declares a dependency on Node.js 24+ (`OpenJS.NodeJS`).
- `InstallerType: nullsoft` is used as a placeholder; change it to match the
  actual installer type (`exe`, `msi`, `zip`, `portable`, `inno`, `wix`, etc.).
