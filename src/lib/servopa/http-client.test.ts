import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { HttpClient, loginProfiles } from "./http-client.js";

test("production login falls back through the validated native profiles", () => {
  assert.deepEqual(loginProfiles(), ["firefox_149", "firefox_147", "firefox_135", "safari_18"]);
  assert.deepEqual(loginProfiles("chrome_142"), ["chrome_142"]);
});

function clientWithFetch(fetch: (url: string, options?: unknown) => Promise<unknown>): HttpClient {
  const client = new HttpClient({ cpfCnpj: "fixture", senha: "fixture" });
  Object.assign(client, { session: { fetch } });
  return client;
}

async function advance(t: TestContext, milliseconds: number): Promise<void> {
  // Flush the async fetch before advancing its retry timer.
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  t.mock.timers.tick(milliseconds);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

test("GET retries transient HTTP failures in the same session with bounded delays", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const statuses = [403, 503, 200];
  const fetch = t.mock.fn(async (..._args: [string, unknown?]) => ({ status: statuses.shift() }));
  const client = clientWithFetch(fetch);
  const pending = client.get("/vendas/lances");
  await advance(t, 1_999);
  assert.equal(fetch.mock.callCount(), 1);
  await advance(t, 1);
  assert.equal(fetch.mock.callCount(), 2);
  await advance(t, 4_999);
  assert.equal(fetch.mock.callCount(), 2);
  await advance(t, 1);
  assert.equal((await pending).status, 200);
  assert.equal(fetch.mock.callCount(), 3);
  for (const call of fetch.mock.calls) {
    assert.equal(call.arguments[0], "https://www.consorcioservopa.com.br/vendas/lances");
  }
});

test("GET returns the last response after three failures and does not retry 404", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetch = t.mock.fn(async (..._args: [string, unknown?]) => ({ status: 403 }));
  const pending = clientWithFetch(fetch).get("/vendas/extrato");
  await advance(t, 2_000);
  await advance(t, 5_000);
  assert.equal((await pending).status, 403);
  assert.equal(fetch.mock.callCount(), 3);
  const missing = t.mock.fn(async (..._args: [string, unknown?]) => ({ status: 404 }));
  assert.equal((await clientWithFetch(missing).get("/missing")).status, 404);
  assert.equal(missing.mock.callCount(), 1);
});

test("downloads recover from network errors without changing download headers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const fetch = t.mock.fn(async (..._args: [string, unknown?]) => {
    if (++attempts === 1) throw new Error("socket ECONNRESET");
    return { status: 200, ok: true, arrayBuffer: async () => Uint8Array.from([1, 2]).buffer };
  });
  const pending = clientWithFetch(fetch).getBuffer("/download");
  await advance(t, 2_000);
  assert.deepEqual(await pending, Buffer.from([1, 2]));
  assert.equal(fetch.mock.callCount(), 2);
  assert.deepEqual(fetch.mock.calls[0].arguments, fetch.mock.calls[1].arguments);
});

test("all POST methods retry explicit 403 rejections, but not uncertain registration failures", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rejected = t.mock.fn(async (..._args: [string, unknown?]) => ({ status: 403 }));
  const client = clientWithFetch(rejected);
  for (const send of [
    () => client.post("/vendas/lances-register", "contract=fixture"),
    () => client.postJson("/vendas/_app/downloads.ajax.php", { categoria: "PRO" }),
    () => client.postRaw("/vendas/lances-register", "{}"),
  ]) {
    const pending = send();
    await advance(t, 2_000);
    await advance(t, 5_000);
    assert.equal((await pending).status, 403);
  }
  assert.equal(rejected.mock.callCount(), 9);
  for (let start = 0; start < 9; start += 3) {
    assert.deepEqual(rejected.mock.calls[start].arguments, rejected.mock.calls[start + 2].arguments);
  }
  const serverError = t.mock.fn(async (..._args: [string, unknown?]) => ({ status: 500 }));
  assert.equal((await clientWithFetch(serverError).postRaw("/vendas/lances-register", "{}")).status, 500);
  assert.equal(serverError.mock.callCount(), 1);
  const lostResponse = t.mock.fn(async (..._args: [string, unknown?]) => { throw new Error("socket ECONNRESET"); });
  await assert.rejects(clientWithFetch(lostResponse).postRaw("/vendas/lances-register", "{}"), /ECONNRESET/);
  assert.equal(lostResponse.mock.callCount(), 1);
  let attempts = 0;
  const simulation = t.mock.fn(async (..._args: [string, unknown?]) => ({ status: ++attempts === 1 ? 503 : 200 }));
  const pending = clientWithFetch(simulation).post("/vendas/lances", new URLSearchParams({ lance: "30" }), { retrySafe: true });
  await advance(t, 2_000);
  assert.equal((await pending).status, 200);
  assert.deepEqual(simulation.mock.calls[0].arguments, simulation.mock.calls[1].arguments);
});

test("logout also retries 403 while preserving manual redirect handling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const fetch = t.mock.fn(async (..._args: [string, unknown?]) => ({ status: ++attempts === 1 ? 403 : 302 }));
  const pending = clientWithFetch(fetch).logout();
  await advance(t, 2_000);
  await pending;
  assert.equal(fetch.mock.callCount(), 2);
  assert.deepEqual(fetch.mock.calls[0].arguments, [
    "https://www.consorcioservopa.com.br/vendas/logout", { redirect: "manual" },
  ]);
});
