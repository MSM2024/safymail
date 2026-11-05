import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const html=readFileSync(new URL("../../public/index.html",import.meta.url),"utf8");
const save=html.split("async function saveDraft(closeAfter=false){")[1]?.split("async function closeComposerSafely(){")[0]||"";
const close=html.split("async function closeComposerSafely(){")[1]?.split("function scheduleDraftSave(){")[0]||"";

test("draft autosave preserves text even when file input contains attachments",()=>{
 assert.match(save,/const generation=draftGeneration,revision=draftRevision,payload=draftPayload\(\)/);
 assert.doesNotMatch(save,/if\(\$\("draft-files"\)\.files\.length\)\{[\s\S]*?return false/);
 assert.match(save,/Los adjuntos se conservan solo hasta cerrar el redactor/);
});

test("closing a composer with attachments explicitly warns before discarding the files",()=>{
 assert.match(close,/files\.length&&!confirm\(/);
 assert.match(close,/Los archivos adjuntos seleccionados no se guardan en el borrador/);
 assert.match(close,/await saveDraft\(true\)/);
});

test("close, Save Draft and Escape share the guarded close flow",()=>{
 assert.match(html,/\$\("close-compose"\)\.onclick=\(\)=>\{void closeComposerSafely\(\);\}/);
 assert.match(html,/\$\("save-draft"\)\.onclick=\(\)=>\{void closeComposerSafely\(\);\}/);
 assert.match(html,/addEventListener\("cancel",event=>\{event\.preventDefault\(\);void closeComposerSafely\(\);\}\)/);
});
