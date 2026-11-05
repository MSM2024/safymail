import test from "node:test";
import assert from "node:assert/strict";
import { makeManifest, validateManifest, readPublishedRelease, compareRelease, gitFileAtCommit, TARGET } from "./p2-release-provenance.mjs";

const sha = "a".repeat(40);
const manifest = makeManifest(sha, Buffer.from("worker"), Buffer.from("shell"), "2026-11-05T12:00:00.000Z");

test("release metadata uses deterministic SHA-256 fingerprints and no credentials", () => {
  assert.equal(manifest.schema, "msm-mail-release-v1");
  assert.equal(manifest.commit, sha);
  assert.equal(manifest.sourceSha256.length, 64);
  assert.equal(manifest.shellSha256.length, 64);
  assert.ok(validateManifest(manifest));
  assert.equal(compareRelease({result:"published", manifest}, sha, Buffer.from("worker"), Buffer.from("shell")), "manifest-match");
});

test("fails closed on altered files, wrong commits, malformed manifest", () => {
  assert.equal(compareRelease({result:"published", manifest}, "b".repeat(40), "worker", "shell"), "commit-mismatch");
  assert.equal(compareRelease({result:"published", manifest}, sha, "tampered", "shell"), "source-mismatch");
  assert.equal(compareRelease({result:"published", manifest}, sha, "worker", "tampered"), "shell-mismatch");
  assert.equal(validateManifest({...manifest,sourceSha256:"no"}), false);
  assert.equal(validateManifest({...manifest,commit:"../../etc"}), false);
  assert.equal(validateManifest({...manifest,preparedAt:"not-a-date"}), false);
});

test("public probe sends GET to fixed trusted host and does not follow redirects", async () => {
  let request;
  const data = await readPublishedRelease(async (url,init) => {
    request={url,init};
    return new Response(JSON.stringify(manifest),{status:200,headers:{"content-type":"application/json"}});
  });
  assert.equal(data.result, "published");
  assert.equal(request.url, TARGET);
  assert.equal(request.init.method,"GET");
  assert.equal(request.init.redirect,"manual");
  assert.equal(request.init.headers.Authorization,undefined);
});

test("rejects SPA fallback HTML, redirects and malformed JSON", async () => {
  assert.equal((await readPublishedRelease(async()=>new Response("<html></html>",{headers:{"content-type":"text/html"}}))).result,"unexpected-content-type");
  assert.equal((await readPublishedRelease(async()=>new Response("",{status:307,headers:{Location:"https://evil.example"}}))).result,"not-published");
  assert.equal((await readPublishedRelease(async()=>new Response("{",{headers:{"content-type":"application/json"}}))).result,"invalid-json");
  assert.equal((await readPublishedRelease(async()=>new Response(JSON.stringify({commit:sha}),{headers:{"content-type":"application/json"}}))).result,"invalid-manifest");
});

test("reads exact historical Git blob rather than changing checkout HEAD", () => {
  const calls = [];
  const fakeExec = (cmd, args, opts) => {
    calls.push({cmd,args,opts});
    return Buffer.from("historical");
  };
  const blob = gitFileAtCommit(sha, "src/index.ts", fakeExec);
  assert.equal(blob.toString(), "historical");
  assert.deepEqual(calls[0].args, ["show", sha + ":src/index.ts"]);
  assert.equal(calls[0].opts.stdio[0], "ignore");
  assert.throws(() => gitFileAtCommit("../../etc", "src/index.ts", fakeExec), /invalid Git/);
  assert.throws(() => gitFileAtCommit(sha, ".env", fakeExec), /invalid Git/);
});

test("published manifest can match historical Git bytes while HEAD has advanced", () => {
  const older = makeManifest(sha, "older-worker", "older-shell", "2026-11-05T17:35:25Z");
  assert.equal(compareRelease({result:"published",manifest:older}, sha, "older-worker", "older-shell"), "manifest-match");
  assert.equal(compareRelease({result:"published",manifest:older}, "b".repeat(40), "older-worker", "older-shell"), "commit-mismatch");
});
