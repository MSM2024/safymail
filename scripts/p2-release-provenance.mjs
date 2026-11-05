import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export const TARGET = "https://mailme.msmmystore.com/msm-release.json";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "public", "msm-release.json");
const hex = /^[0-9a-f]{64}$/;
const gitSha = /^[0-9a-f]{40}$/;

export function fingerprint(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function makeManifest(commit, source, shell, createdAt) {
  if (!gitSha.test(commit) || !Number.isFinite(Date.parse(createdAt))) throw Error("invalid release identity");
  return {
    schema: "msm-mail-release-v1",
    commit,
    sourceSha256: fingerprint(source),
    shellSha256: fingerprint(shell),
    preparedAt: createdAt
  };
}

export function validateManifest(manifest) {
  return manifest && !Array.isArray(manifest) && manifest.schema === "msm-mail-release-v1" &&
    typeof manifest.commit === "string" && gitSha.test(manifest.commit) &&
    typeof manifest.sourceSha256 === "string" && hex.test(manifest.sourceSha256) &&
    typeof manifest.shellSha256 === "string" && hex.test(manifest.shellSha256) &&
    typeof manifest.preparedAt === "string" && Number.isFinite(Date.parse(manifest.preparedAt));
}

export async function readPublishedRelease(fetchFn = fetch) {
  const response = await fetchFn(TARGET, {
    method: "GET", redirect: "manual", cache: "no-store",
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(12000)
  });
  if (response.status !== 200) return { result: "not-published", status: response.status };
  const mime = (response.headers.get("content-type") || "").toLowerCase();
  if (!mime.includes("application/json")) return { result: "unexpected-content-type", status: response.status };
  let payload;
  try { payload = await response.json(); } catch { return { result: "invalid-json", status: response.status }; }
  if (!validateManifest(payload)) return { result: "invalid-manifest", status: response.status };
  return { result: "published", status: 200, manifest: payload };
}

export function compareRelease(published, expectedCommit, source, shell) {
  if (!gitSha.test(expectedCommit)) return "invalid-commit";
  if (published.result !== "published") return published.result;
  if (published.manifest.commit !== expectedCommit) return "commit-mismatch";
  if (published.manifest.sourceSha256 !== fingerprint(source)) return "source-mismatch";
  if (published.manifest.shellSha256 !== fingerprint(shell)) return "shell-mismatch";
  return "manifest-match";
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function main() {
  const mode = process.argv[2];
  if (!["prepare", "verify"].includes(mode)) {
    console.error("Usage: node scripts/p2-release-provenance.mjs prepare|verify");
    process.exitCode = 2;
    return;
  }
  const source = readFileSync(path.join(root, "src", "index.ts"));
  const shell = readFileSync(path.join(root, "public", "index.html"));
  const commit = git(["rev-parse", "HEAD"]);
  if (mode === "prepare") {
    if (git(["status", "--porcelain", "--untracked-files=no"]) !== "") {
      throw Error("tracked working tree must be clean before preparing a release");
    }
    const manifest = makeManifest(commit, source, shell, new Date().toISOString());
    writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n", { flag: "w" });
    console.log("P2 RELEASE PREPARED (local assets only): " + manifest.commit);
    console.log("Manifest: public/msm-release.json");
    console.log("No Worker deployed, no DNS, secrets, database or mail changed.");
    return;
  }
  const remote = await readPublishedRelease();
  const result = compareRelease(remote, commit, source, shell);
  console.log("P2 RELEASE PROVENANCE: " + JSON.stringify({ result, status: remote.status ?? null, expectedCommit: commit, publishedCommit: remote.manifest?.commit ?? null }));
  if (result !== "manifest-match") {
    console.error("P2-01 NOT VERIFIED: compare a prepared and deployed release before asserting identity.");
    process.exitCode = 1;
  } else {
    console.log("Manifest matches local Git SHA and source fingerprints. Confirm Cloudflare Worker version ID separately from deploy output.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error("P2-01 NOT VERIFIED: " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
