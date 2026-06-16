# Homebrew Cask for Conan — ready to submit to Homebrew/homebrew-cask.
#
# BLOCKED ON NOTABILITY until the repo clears Homebrew's popularity bar:
#   - community-submitted PR: 75 stars OR 30 forks OR 30 watchers
#   - self-submitted (repo owner): 225 stars OR 90 forks OR 90 watchers
# As of the last check the repo had 0/0/0 — drive stars (Product Hunt) first.
#
# To submit once eligible:
#   1. Bump `version` + `sha256` to the latest release (see below to recompute).
#   2. `brew audit --new --cask packaging/conan.rb` must pass clean.
#   3. Open a PR adding this file to Homebrew/homebrew-cask under Casks/c/conan.rb.
#
# Recompute sha256 for a new release (must match the PUBLISHED GitHub asset,
# not a local rebuild — signing timestamps differ between builds):
#   gh release download v<VER> --repo thewhatmatters/conan \
#     --pattern "Conan_<VER>_aarch64.dmg" --output /tmp/conan.dmg --clobber
#   shasum -a 256 /tmp/conan.dmg

cask "conan" do
  version "1.0.5"
  sha256 "85a1139e3311ab3de46ae0d7a3c39a276e4a015c6b92fbd79330a007f2644f50"

  url "https://github.com/thewhatmatters/conan/releases/download/v#{version}/Conan_#{version}_aarch64.dmg",
      verified: "github.com/thewhatmatters/conan/"
  name "Conan"
  desc "Terminal-primary HUD that wraps and observes Claude Code"
  homepage "https://conan.sh/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true # ships its own Tauri updater
  depends_on macos: ">= :ventura"
  depends_on arch: :arm64

  app "Conan.app"

  zap trash: [
    "~/Library/Application Support/so.whatmatters.conan",
    "~/Library/Caches/so.whatmatters.conan",
    "~/Library/Preferences/so.whatmatters.conan.plist",
    "~/Library/Saved Application State/so.whatmatters.conan.savedState",
  ]
end
