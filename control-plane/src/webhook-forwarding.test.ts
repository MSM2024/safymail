import test from "node:test";
import assert from "node:assert/strict";
import { resolveMailWebhookRoute } from "./webhook-forwarding";

test("routes MSM domain to its explicitly configured mailme host over bound service", () => {
  assert.deepEqual(resolveMailWebhookRoute("msmmystore.com","msmmystore.com","mailme.msmmystore.com"),{
    url:"https://mailme.msmmystore.com/api/webhooks/resend",useBinding:true
  });
});
test("does not route other tenant installations through MSM binding", () => {
  assert.deepEqual(resolveMailWebhookRoute("other-example.com","msmmystore.com","mailme.msmmystore.com"),{
    url:"https://mail.other-example.com/api/webhooks/resend",useBinding:false
  });
});
test("refuses cross-domain and unsafe host overrides", () => {
  for (const host of ["attacker.example.com","msmmystore.com.evil.test","https://mailme.msmmystore.com","mailme.msmmystore.com:444","mailme.msmmystore.com/path"]) {
    assert.deepEqual(resolveMailWebhookRoute("msmmystore.com","msmmystore.com",host),{
      url:"https://mail.msmmystore.com/api/webhooks/resend",useBinding:false
    });
  }
});
