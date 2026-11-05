import test from "node:test";
import assert from "node:assert/strict";
import {classify, verify, comparePublicShells, EXPECTED, OLD} from "./verify-public-deploy.mjs";

test("classifies current, stale and unknown public login shells", () => {
  assert.equal(classify("<html>" + EXPECTED + "</html>"), "current");
  assert.equal(classify("<html>" + OLD + "</html>"), "stale");
  assert.equal(classify("<html>other</html>"), "unknown");
});

test("requests exact public domain without credentials or redirects", async () => {
  let seen;
  const result = await verify(undefined, async (url, init) => {
    seen = {url, init};
    return new Response("<html>" + EXPECTED + "</html>", {headers: {"Content-Type": "text/html"}});
  });
  assert.equal(result.result, "current");
  assert.equal(seen.url, "https://mailme.msmmystore.com/");
  assert.equal(seen.init.redirect, "manual");
  assert.equal(seen.init.cache, "no-store");
  assert.equal(seen.init.headers.Authorization, undefined);
});

test("does not treat redirect or error as success", async () => {
  const result = await verify(undefined, async () => new Response("", {status: 302, headers: {Location: "https://other.example"}}));
  assert.equal(result.result, "http-error");
});

test("rejects unknown hosts and HTTP", async () => {
  await assert.rejects(verify("https://example.com/", async () => {throw Error("must not fetch");}), /Target must/);
  await assert.rejects(verify("http://mailme.msmmystore.com/", async () => {throw Error("must not fetch");}), /Target must/);
});

test("comparative probe uses fixed public routes and reports stale variants", async () => {
  const seen = [];
  const results = await comparePublicShells(async (url, init) => {
    seen.push({url, init});
    const body = url.includes("msm_p1_probe") ? EXPECTED : OLD;
    return new Response("<html>" + body + "</html>", {headers: {"Content-Type":"text/html","CF-Cache-Status":"HIT","Age":"120"}});
  });
  assert.deepEqual(results.map(item => item.result), ["stale","stale","current"]);
  assert.deepEqual(seen.map(item => new URL(item.url).pathname), ["/","/index.html","/index.html"]);
  assert.ok(seen.every(item => item.init.redirect === "manual" && item.init.cache === "no-store"));
  assert.ok(seen.every(item => new URL(item.url).hostname === "mailme.msmmystore.com"));
});
