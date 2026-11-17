const VERSION = "2026.10.22-27dcf5f";
const BUILD = `https://downloads.cursor.com/lab/${VERSION}/linux`;
const LAUNCHER_SHA256 = "2ccc9a8e167797641448b5e5c936f006ba137a2555f117f38c5eb76a5238a233";
export const CURSOR_STANDALONE = {
    name: "Cursor",
    engine: "cursor-agent",
    version: VERSION,
    hosts: ["downloads.cursor.com"],
    launcher: true,
    previousPrograms: {},
    assets: {
        "linux-x64": { url: `${BUILD}/x64/agent-cli-package.tar.gz`, archive: "tar.gz", executable: "dist-package/cursor-agent", approxBytes: 184_859_176, sha256: "85296944e4600a83c4b764f578d1502bf9c416db200d33a593e8f3ecabfdc294", executableSha256: LAUNCHER_SHA256 },
        "linux-arm64": { url: `${BUILD}/arm64/agent-cli-package.tar.gz`, archive: "tar.gz", executable: "dist-package/cursor-agent", approxBytes: 182_799_294, sha256: "22a36df9720830668ccd4d707e5190204ab9c8a0efb2f068cc914895f804d3ec", executableSha256: LAUNCHER_SHA256 },
    },
};
