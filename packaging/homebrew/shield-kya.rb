class ShieldKya < Formula
  desc "Audit trail and traceability for AI agents"
  homepage "https://shield-agent.com/install"
  url "https://registry.npmjs.org/@shield-agent/kya/-/kya-0.27.0.tgz"
  sha256 "16b1d6e2e04d90d378efe8367e8a85aba9a8a67c4b47ac498cc39d221fc8def8"
  license "MIT"

  # kya needs Node >= 22 (package.json engines). Homebrew "node" is the current
  # release line (26.x on 2026-10-10), which satisfies it and is what
  # Language::Node expects; node@24 is keg-only and would need PATH plumbing.
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    # kya 0.23.1 has no --version flag: it prints usage and exits 0. Assert that, plus the
    # packaged version. Once kya ships --version, replace both lines with:
    #   assert_match version.to_s, shell_output("#{bin}/kya --version")
    assert_match "Usage:", shell_output("#{bin}/kya --version")
    pkg = libexec/"lib/node_modules/@shield-agent/kya/package.json"
    assert_equal version.to_s, JSON.parse(pkg.read)["version"]
    # Offline policy decision, no network: a never-allowed tool is denied with exit 1.
    output = shell_output("#{bin}/kya eval-tool --offline --tool-id org.sample.never.event --irreversible", 1)
    assert_match "DENY", output
  end
end
