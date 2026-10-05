class ShieldKya < Formula
  desc "Audit trail and traceability for AI agents"
  homepage "https://shield-agent.com/install"
  url "https://registry.npmjs.org/@shield-agent/kya/-/kya-0.19.0.tgz"
  sha256 "c5a451dce71dcbbae603666c1cb32699a60d2539e47117944562cd3fd4828a73"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    system bin/"kya", "--help"
  end
end
