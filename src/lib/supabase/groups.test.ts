import test from "node:test";
import assert from "node:assert/strict";
import { groupListingFixture, groupDetailsFixture } from "../../../test-fixtures/groups.js";
import { parseGroupDetails, parseGroupHistory, parseGroupListing } from "../servopa/groups.js";
import { HttpClient } from "../servopa/http-client.js";
import { mergeGroupData, runGroupSync, type GroupRow } from "./groups.js";

test("group merge preserves failed sections and old history, and retires only missing plans", () => {
  const html = groupDetailsFixture();
  const sections = { ...parseGroupDetails(html, 9999),
    historico_com_embutido: parseGroupHistory(groupDetailsFixture("COM EMBUTIDO"), 9999, "com_embutido") };
  const first = mergeGroupData(undefined, 9999, parseGroupListing(groupListingFixture(), 9999), sections, "2026-10-29T12:00:00Z");
  first.planos!.push({ ...first.planos![0], categoria: "OLD" });
  first.assembleias!.push({ ...first.assembleias![0], numero: 16 });
  const original = structuredClone(first);
  const next = mergeGroupData(first, 9999, parseGroupListing(groupListingFixture(), 9999), {
    ...sections, cadastro: { status: "falha", erro: "fixture" },
    historico_sem_embutido: { status: "sem_historico" },
    historico_com_embutido: { status: "falha", erro: "fixture" },
  }, "2026-10-30T12:00:00Z");
  assert.deepEqual(first, original);
  assert.equal(next.planos!.length, 2);
  assert.equal(next.planos!.find((row) => row.categoria === "OLD")!.disponivel, false);
  assert.equal(next.planos![0].disponivel, true);
  assert.equal(next.assembleias!.length, 2);
  assert.deepEqual(next.historico_lances, first.historico_lances);
  assert.equal(next.atualizacao_secoes!.cadastro, "2026-10-29T12:00:00Z");
  assert.equal(next.atualizacao_secoes!.planos, "2026-10-30T12:00:00Z");
});

test("group workflow discovers, deduplicates, supports dry run and records partial/failed runs", async (t) => {
  Object.assign(process.env, {
    SERVOPA_CPF_CNPJ: "fixture", SERVOPA_SENHA: "fixture",
    SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fixture",
    ZAPI_INSTANCE_ID: "fixture", ZAPI_INSTANCE_TOKEN: "fixture", ZAPI_CLIENT_TOKEN: "fixture",
  });
  let stored: GroupRow[] = [];
  const logs: { status: string; trigger_run_id: string }[] = [];
  let groupWrites = 0;
  let failEmbedded = false;
  let wrongGroup = false;
  let failAudit = false;
  t.mock.method(HttpClient.prototype, "login", async () => undefined);
  t.mock.method(HttpClient.prototype, "logout", async () => undefined);
  t.mock.method(HttpClient.prototype, "close", async () => undefined);
  t.mock.method(HttpClient.prototype, "post", async (path: string, body?: string | URLSearchParams) => {
    assert.equal(path, "/vendas/grupos");
    const group = Number(new URLSearchParams(body).get("grupofrm"));
    return { ok: true, text: async () => groupListingFixture(group) } as never;
  });
  t.mock.method(HttpClient.prototype, "get", async (path: string) => {
    if (failEmbedded && path.endsWith("/L")) throw Error("fixture history unavailable");
    const group = Number(path.split("/").at(-2));
    return { ok: true, text: async () => groupDetailsFixture(path.endsWith("/L") ? "COM EMBUTIDO" : "SEM EMBUTIDO", wrongGroup ? 1111 : group) } as never;
  });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "fixture.supabase.co");
    if (url.pathname === "/rest/v1/bd_producao") return new Response(JSON.stringify([{ nr_grupo: 9999 }, { nr_grupo: "9999" }]));
    if (url.pathname === "/rest/v1/grupos" && init?.method === "GET") return new Response(JSON.stringify(stored));
    if (url.pathname === "/rest/v1/grupos") {
      assert.equal(url.searchParams.get("on_conflict"), "nr_grupo");
      groupWrites++;
      stored = JSON.parse(String(init?.body));
      return new Response(null, { status: 201 });
    }
    assert.equal(url.pathname, "/rest/v1/grupos_sincronizacoes");
    if (failAudit) return new Response(null, { status: 503 });
    logs.push(...JSON.parse(String(init?.body)));
    return new Response(null, { status: 201 });
  });
  const logger = { log: () => undefined };
  assert.equal((await runGroupSync({ dryRun: true }, "fixture-run", logger)).groupCount, 1);
  assert.equal(groupWrites, 0);
  assert.equal(logs.length, 0);
  const first = await runGroupSync({}, "fixture-run", logger);
  assert.equal(first.successCount, 1);
  assert.equal(first.changedCount, 1);
  assert.equal(logs[0].trigger_run_id, "fixture-run");
  stored[0].proxima_assembleia_em = "2026-11-23T19:00:00+00:00";
  assert.equal((await runGroupSync({}, "fixture-run-2", logger)).changedCount, 0);
  assert.equal(logs.length, 2);
  const oldHistory = structuredClone(stored[0].historico_lances);
  failEmbedded = true;
  assert.equal((await runGroupSync({}, "fixture-run-3", logger)).partialCount, 1);
  assert.deepEqual(stored[0].historico_lances, oldHistory);
  wrongGroup = true;
  const writesBeforeFailure = groupWrites;
  assert.equal((await runGroupSync({}, "fixture-run-4", logger)).errorCount, 1);
  assert.equal(groupWrites, writesBeforeFailure);
  assert.equal(logs.at(-1)!.status, "falha");
  wrongGroup = false;
  failAudit = true;
  await assert.rejects(runGroupSync({}, "fixture-run-5", logger), /database write failed/);
  await assert.rejects(runGroupSync({ groups: [0] }, undefined, logger), /requires groups/);
});
