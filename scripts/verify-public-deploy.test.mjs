import test from "node:test";
import assert from "node:assert/strict";
import {classify, verify, EXPECTED, OLD} from "./verify-public-deploy.mjs";

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
