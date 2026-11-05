import test from "node:test";
import assert from "node:assert/strict";
import { makeManifest, validateManifest, readPublishedRelease, compareRelease, TARGET } from "./p2-release-provenance.mjs";

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
