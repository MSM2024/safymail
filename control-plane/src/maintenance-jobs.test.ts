import test from "node:test";
import assert from "node:assert/strict";
import { processMaintenanceBatch } from "./maintenance-jobs";
import { deriveMaintenanceToken } from "./provisioning-jobs";

const vault = "test-vault-key-".repeat(3);
const installationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function fakeDb(rows: Array<{ id: string; domain: string }>) {
  return {
    prepare(_sql: string) {
      return {
        bind(..._values: unknown[]) {
          return { all: async () => ({ results: rows }) };
        }
      };
    }
  } as unknown as D1Database;
}

test("maintenance dispatch calls only ready installation origins with their derived bearer token", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization: string | null; redirect: RequestRedirect; slot: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("Authorization"),
      redirect: init?.redirect || "follow",
      slot: new Headers(init?.headers).get("X-Mail-Center-Scheduler-Slot")
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await processMaintenanceBatch({
      CONTROL_DB: fakeDb([{ id: installationId, domain: "mail.example.test" }]),
      CONTROL_PLANE_VAULT_KEY: vault
    }, [installationId], "2026-11-03T12:15:00.000Z");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://mail.example.test/api/internal/maintenance");
    assert.equal(calls[0].authorization, "Bearer " + await deriveMaintenanceToken(vault, installationId));
    assert.equal(calls[0].redirect, "manual");
    assert.equal(calls[0].slot, "2026-11-03T12:15:00.000Z");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("maintenance dispatch rejects oversized batches before querying installations", async () => {
  let queried = false;
  const db = {
    prepare() { queried = true; throw new Error("should not query"); }
  } as unknown as D1Database;
  await assert.rejects(
    () => processMaintenanceBatch({ CONTROL_DB: db, CONTROL_PLANE_VAULT_KEY: vault }, Array.from({ length: 11 }, (_, i) => "bbbbbbbb-bbbb-4bbb-8bbb-" + String(i).padStart(12, "0")), "2026-11-03T12:15:00.000Z"),
    /Invalid maintenance batch/
  );
  assert.equal(queried, false);
});

test("maintenance uses MSM scoped service binding and mailme host, not apex or public fetch", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{url:string; auth:string|null; redirect:RequestRedirect|undefined}> = [];
  globalThis.fetch = (async () => { throw new Error("public fetch must not be used"); }) as typeof fetch;
  try {
    await processMaintenanceBatch({
      CONTROL_DB: fakeDb([{id: installationId,domain:"msmmystore.com"}]),
      CONTROL_PLANE_VAULT_KEY: vault,
      MAIL_DELIVERY_DOMAIN:"msmmystore.com",
      MAIL_DELIVERY_HOST:"mailme.msmmystore.com",
      MAIL_DELIVERY_SERVICE: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          calls.push({url:String(input),auth:new Headers(init?.headers).get("Authorization"),redirect:init?.redirect});
          return new Response("{}",{status:200});
        }
      } as unknown as Fetcher
    },[installationId],"2026-11-03T12:30:00.000Z");
    assert.deepEqual(calls, [{
      url:"https://mailme.msmmystore.com/api/internal/maintenance",
      auth:"Bearer "+await deriveMaintenanceToken(vault,installationId),
      redirect:"manual"
    }]);
  } finally {globalThis.fetch=previousFetch;}
});
