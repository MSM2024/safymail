import test from "node:test";
import assert from "node:assert/strict";
import { CloudflareClient } from "./cloudflare";
import { ResendClient } from "./resend";

test("Cloudflare D1 discovery prevents duplicate creation", async () => {
  const calls: string[] = [];
  const client = new CloudflareClient({
    accountId: "a".repeat(32), apiToken: "x".repeat(40),
    fetcher: async (input, init) => {
      const url = String(input); calls.push((init?.method || "GET") + " " + url);
      return new Response(JSON.stringify({ success: true, result: [{ uuid: "db-id", name: "mail-db" }] }), { status: 200 });
    }
  });
  const result = await client.ensureD1("mail-db");
  assert.equal(result.created, false);
  assert.equal(result.database.uuid, "db-id");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].startsWith("GET "), true);
});

test("Cloudflare creates D1 only when discovery returns no match", async () => {
  const methods: string[] = [];
  const client = new CloudflareClient({
    accountId: "a".repeat(32), apiToken: "x".repeat(40),
    fetcher: async (_input, init) => {
      methods.push(init?.method || "GET");
      if (init?.method === "POST") return new Response(JSON.stringify({ success: true, result: { uuid: "new-db", name: "new-db" } }), { status: 200 });
      return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
    }
  });
  const result = await client.ensureD1("new-db");
  assert.equal(result.created, true);
  assert.deepEqual(methods, ["GET", "POST"]);
});

test("Resend refuses to reuse an existing webhook without its signing secret", async () => {
  const client = new ResendClient({
    apiKey: "re_" + "x".repeat(40),
    fetcher: async () => new Response(JSON.stringify({ data: [{ id: "wh-1", endpoint: "https://mail.example.com/api/webhooks/resend", events: [] }] }), { status: 200 })
  });
  await assert.rejects(
    () => client.ensureWebhook("https://mail.example.com/api/webhooks/resend", ["email.sent"]),
    (error: any) => error.status === 409 && error.provider === "resend"
  );
});

test("Resend returns webhook signing secret only to the trusted caller", async () => {
  const client = new ResendClient({
    apiKey: "re_" + "x".repeat(40),
    fetcher: async (_input, init) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ data: {
        id: "wh-2", endpoint: "https://mail.example.com/api/webhooks/resend",
        events: ["email.sent"], signing_secret: "whsec_sensitive"
      } }), { status: 200 });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
  });
  const result = await client.ensureWebhook("https://mail.example.com/api/webhooks/resend", ["email.sent"]);
  assert.equal(result.created, true);
  assert.equal(result.signingSecret, "whsec_sensitive");
});


test("Cloudflare zone preflight only accepts an exact domain match", async () => {
  const client = new CloudflareClient({
    accountId: "a".repeat(32), apiToken: "x".repeat(40),
    fetcher: async () => new Response(JSON.stringify({ success: true, result: [
      { id: "zone-sub", name: "mail.example.com", status: "active" },
      { id: "zone-root", name: "example.com", status: "active" }
    ] }), { status: 200 })
  });
  const zone = await client.findZone("example.com");
  assert.equal(zone?.id, "zone-root");
  assert.equal(await client.findZone("missing.example"), null);
});

test("Cloudflare Free D1 capacity blocks creation before side effects", async () => {
  const methods: string[] = [];
  const client = new CloudflareClient({
    accountId: "a".repeat(32), apiToken: "x".repeat(40),
    fetcher: async (_input, init) => {
      methods.push(init?.method || "GET");
      return new Response(JSON.stringify({ success: true, result: Array.from({ length: 10 }, (_, i) => ({ uuid: String(i), name: "db-" + i })) }), { status: 200 });
    }
  });
  await assert.rejects(() => client.assertFreeCapacity("new-db", "new-worker", "new-kv"), (error: any) => error.status === 429);
  assert.deepEqual(methods, ["GET", "GET", "GET"]);
});

test("Resend Free preflight blocks a second webhook endpoint before creation", async () => {
  const methods: string[] = [];
  const client = new ResendClient({
    apiKey: "re_" + "x".repeat(40),
    fetcher: async (input, init) => {
      methods.push(init?.method || "GET");
      return new Response(JSON.stringify({ data: String(input).endsWith("/domains") ? [] : [
        { id: "wh-existing", endpoint: "https://other.example/api/webhooks/resend", events: [] }
      ] }), { status: 200 });
    }
  });
  await assert.rejects(
    () => client.assertFreeCapacity("mail.example.com", "https://mail.example.com/api/webhooks/resend", 1),
    (error: any) => error.status === 409 && error.provider === "resend"
  );
  assert.deepEqual(methods, ["GET", "GET"]);
});

test("Resend Free policy rejects a third Mail Center managed domain", async () => {
  let calls = 0;
  const client = new ResendClient({
    apiKey: "re_" + "x".repeat(40),
    fetcher: async () => {
      calls++;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
  });
  await assert.rejects(
    () => client.assertFreeCapacity("third.example.com", "https://control.example.com/webhooks/resend/provider-1", 3),
    (error: any) => error.status === 409 && /two domains managed/.test(error.message)
  );
  assert.equal(calls, 2);
});

test("Cloudflare Free Worker capacity blocks before any resource creation", async () => {
  const urls: string[] = [];
  const client = new CloudflareClient({
    accountId: "a".repeat(32), apiToken: "x".repeat(40),
    fetcher: async input => {
      const url = String(input); urls.push(url);
      const result = url.includes("/workers/scripts") && new URL(url).searchParams.get("page") === "1"
        ? Array.from({ length: 100 }, (_, i) => ({ id: "worker-" + i }))
        : [];
      return new Response(JSON.stringify({ success: true, result }), { status: 200 });
    }
  });
  await assert.rejects(() => client.assertFreeCapacity("new-db", "new-worker", "new-kv"), (error: any) => error.status === 429);
  assert.equal(urls.length, 4);
  assert.equal(urls.some(url => url.includes("/workers/scripts")), true);
});


test("Cloudflare Free KV namespace capacity blocks before resource creation", async () => {
  const urls: string[] = [];
  const client = new CloudflareClient({
    accountId: "a".repeat(32), apiToken: "x".repeat(40),
    fetcher: async input => {
      const url = String(input); urls.push(url);
      let result: unknown[] = [];
      if (url.includes("/storage/kv/namespaces") && !url.includes("page=11")) {
        const page = Number(new URL(url).searchParams.get("page") || "1");
        result = Array.from({ length: 100 }, (_, i) => ({ id: "kv-" + ((page - 1) * 100 + i), title: "namespace-" + ((page - 1) * 100 + i) }));
      }
      return new Response(JSON.stringify({ success: true, result }), { status: 200 });
    }
  });
  await assert.rejects(
    () => client.assertFreeCapacity("new-db", "new-worker", "new-kv"),
    (error: any) => error.status === 429 && error.provider === "cloudflare" && /KV Free namespace limit/.test(error.message)
  );
  assert.equal(urls.length, 13);
  assert.equal(urls.filter(url => url.includes("/storage/kv/namespaces")).length, 11);
});

test("Cloudflare KV namespace capacity allows reuse at the Free limit", async () => {
  const client = new CloudflareClient({
    accountId: "a".repeat(32), apiToken: "x".repeat(40),
    fetcher: async input => {
      const url = String(input);
      let result: unknown[] = [];
      if (url.includes("/storage/kv/namespaces") && !url.includes("page=11")) {
        const page = Number(new URL(url).searchParams.get("page") || "1");
        result = Array.from({ length: 100 }, (_, i) => {
          const index = (page - 1) * 100 + i;
          return { id: "kv-" + index, title: index === 999 ? "existing-kv" : "namespace-" + index };
        });
      }
      return new Response(JSON.stringify({ success: true, result }), { status: 200 });
    }
  });
  await assert.doesNotReject(() => client.assertFreeCapacity("existing-db", "existing-worker", "existing-kv"));
});

test("Cloudflare default fetch retains the Workers global receiver during token verification", async () => {
  const originalFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = function (this: typeof globalThis, input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    assert.equal(this, globalThis, "Fetch must keep its global receiver in Workers");
    requested = String(input);
    assert.equal((init?.headers as Record<string, string>)?.Authorization, "Bearer " + "x".repeat(40));
    return Promise.resolve(new Response(JSON.stringify({
      success: true, result: { id: "verified-token" }
    }), { status: 200 }));
  } as typeof fetch;
  try {
    const client = new CloudflareClient({ accountId: "a".repeat(32), apiToken: "x".repeat(40) });
    await client.verifyToken();
    assert.equal(requested, "https://api.cloudflare.com/client/v4/user/tokens/verify");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Resend default fetch retains the Workers global receiver during provider preflight", async () => {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = function (this: typeof globalThis, input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    assert.equal(this, globalThis, "Fetch must retain its global receiver in Workers");
    const url = String(input);
    seen.push(url);
    assert.equal((init?.headers as Record<string, string>)?.Authorization, "Bearer re_" + "x".repeat(40));
    return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
  } as typeof fetch;
  try {
    const client = new ResendClient({ apiKey: "re_" + "x".repeat(40) });
    await client.assertFreeCapacity("msmmystore.com", "https://control.example.com/webhooks/resend/provider-id", 1);
    assert.deepEqual(seen.sort(), [
      "https://api.resend.com/domains",
      "https://api.resend.com/webhooks"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
