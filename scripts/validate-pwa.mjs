import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { Script } from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const manifest = JSON.parse(await read("public/manifest.webmanifest"));
const html = await read("public/index.html");
const worker = await read("public/service-worker.js");

assert.equal(manifest.start_url, "/", "PWA start_url must be the webmail root");
assert.equal(manifest.scope, "/", "PWA scope must cover the webmail root");
assert.equal(manifest.display, "standalone", "PWA must launch in standalone mode");
assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, "PWA manifest needs at least one icon");
for (const icon of manifest.icons) {
  assert.ok(icon.src.startsWith("/"), "PWA icon URLs must be same-origin absolute paths");
  await access(new URL("public" + icon.src, root));
}
assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/, "Webmail must link its manifest");
assert.match(html, /id="install-app"/, "Webmail must expose the install control");
assert.match(html, /serviceWorker\.register\("\/service-worker\.js"/, "Webmail must register its service worker");
assert.match(worker, /request\.method!==?"GET"/, "Service worker must ignore non-GET requests");
assert.match(worker, /url\.pathname\.startsWith\("\/api\/"\)/, "Service worker must never cache API responses");
assert.match(worker, /request\.mode===?"navigate"/, "Service worker must provide a navigation fallback");
new Script(worker, { filename: "service-worker.js" });
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
assert.ok(scripts.length > 0, "Webmail must contain its application script");
for (const [index, match] of scripts.entries()) new Script(match[1], { filename: `index-inline-${index}.js` });
console.log("PWA manifest, icons, install hook and private-route cache exclusions are valid.");
