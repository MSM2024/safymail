import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Script} from "node:vm";
const src=readFileSync(new URL("./msm-mailme-custom-domain.mjs",import.meta.url),"utf8");
new Script(src.replace(/^import .*?;$/gm,"").replace(/import\.meta\.url/g,'"script"'),{filename:"msm-mailme-custom-domain.mjs"});
for(const token of ['mailme.msmmystore.com','msm-mail-preview','CLOUDFLARE_API_TOKEN','workers/domains','dns_records?name=','--apply','DRY RUN','service:worker','zone_id:zoneId']){
 assert.ok(src.includes(token),"Missing protective contract: "+token);
}
assert.ok(src.includes('if(!apply)'),"Mutation must be opt-in");
assert.ok(!src.includes("console.log(token)"),"Never print credentials");
assert.ok(!src.includes('dns_records"')||src.includes('dns_records?name='),"Only read DNS records");
console.log("MSM MAIL mailme custom-domain guarded contract PASS");
