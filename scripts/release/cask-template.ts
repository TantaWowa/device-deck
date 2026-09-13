import type { Manifest } from "../../packages/installer/src/index";
export function renderCask(manifests: Manifest[], trust: {accountId:string;productId:string}) {
const quote=(s:string)=>JSON.stringify(s);
const variants=manifests.map(m=>`  on_${m.arch==="arm64"?"arm":"intel"} do\n    sha256 ${quote(m.sha256)}\n    url ${quote(`https://api.keygen.sh/v1/accounts/${trust.accountId}/artifacts/${m.filename}?product=${trust.productId}`)},\n        verified: "api.keygen.sh/v1/accounts/${trust.accountId}/",\n        using: :curl\n    pkg ${quote(m.filename)}\n  end`).join("\n\n");
return `cask "device-deck" do
  version ${quote(manifests[0].version)}
${variants}

  name "Device Deck"
  desc "Local device control, capture and simulator workspace"
  homepage "https://github.com/TantaWowa/device-deck"
  depends_on macos: ">= :sonoma"
${manifests.length===1?`  depends_on arch: :${manifests[0].arch==="arm64"?"arm64":"x86_64"}\n`:""}
  uninstall script: {
              executable: "/Applications/Device Deck.app/Contents/MacOS/devdeck",
              args: ["service", "uninstall"],
              sudo: false,
              must_succeed: true,
            },
            pkgutil: "com.tantawowa.device-deck"

  uninstall_postflight do
    system_command "/bin/sh",
                   args: ["-c", 'cli=/usr/local/bin/devdeck; if [ -L "$cli" ] && [ "$(/usr/bin/readlink "$cli")" = "/Applications/Device Deck.app/Contents/MacOS/devdeck" ]; then /bin/rm -- "$cli"; fi'],
                   sudo: true
  end

  caveats <<~EOS
    Open Device Deck.app after installation. Recording and USB screenshots need
    FFmpeg: brew install ffmpeg. Finish reservations and recordings, then quit
    Device Deck before upgrading. Profiles and captures survive uninstall.
  EOS
end
`;
}
