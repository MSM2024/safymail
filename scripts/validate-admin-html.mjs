import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
if (!script) throw new Error("admin.html must contain its application script");

for (const id of ["notice", "stats", "tabs", "dashboard-panel", "settings-panel", "create-panel", "list-panel", "data"]) {
  if (!html.includes('id="' + id + '"')) throw new Error("Missing admin UI element: " + id);
}

new Function(script);
console.log("Admin HTML structure and inline JavaScript are valid.");
