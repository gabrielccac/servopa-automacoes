import test from "node:test";
import assert from "node:assert/strict";
import { groupListingFixture, groupDetailsFixture } from "../../../test-fixtures/groups.js";
import { parseGroupDetails, parseGroupListing } from "../servopa/groups.js";
import { HttpClient } from "../servopa/http-client.js";
import { mergeGroupData, runGroupSync, type GroupRow } from "./groups.js";

test("group merge preserves failed sections and calendar history but never posts retired fields", () => {
  const sections = parseGroupDetails(groupDetailsFixture(), 9999);
  const listing = parseGroupListing(groupListingFixture(), 9999);
  const first = mergeGroupData(undefined, 9999, listing, sections, "2026-10-29T12:00:00Z");
  first.assembleias!.push({ ...first.assembleias![0], numero: 16 });
  const original = structuredClone(first);
  const next = mergeGroupData(Object.assign({}, first, { planos: ["retired"], created_at: "retired" }), 9999, listing, {
    ...sections, cadastro: { status: "falha", erro: "fixture" },
    taxas_administracao: { status: "falha", erro: "fixture" },
    regras_assembleias: { status: "falha", erro: "fixture" },
  }, "2026-10-30T12:00:00Z");
  assert.deepEqual(first, original);
  assert.deepEqual(next.taxas_administracao, first.taxas_administracao);
  assert.deepEqual(next.regras_assembleias, first.regras_assembleias);
  assert.equal(next.assembleias!.length, 2);
  assert.equal("planos" in next, false);
  assert.equal("created_at" in next, false);
  assert.equal("atualizacao_secoes" in next, false);
});

test("group sync discovers all groups, supports dry run, and logs partial/failed sections without history requests", async (t) => {
  Object.assign(process.env, {
    SERVOPA_CPF_CNPJ: "fixture", SERVOPA_SENHA: "fixture",
    SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fixture",
    ZAPI_INSTANCE_ID: "fixture", ZAPI_INSTANCE_TOKEN: "fixture", ZAPI_CLIENT_TOKEN: "fixture",
  });
  let stored: GroupRow[] = [];
  const logs: { status: string; trigger_run_id: string }[] = [];
  let groupWrites = 0, wrongGroup = false, failAudit = false, failRules = false;
  t.mock.method(HttpClient.prototype, "login", async () => undefined);
  t.mock.method(HttpClient.prototype, "logout", async () => undefined);
  t.mock.method(HttpClient.prototype, "close", async () => undefined);
  t.mock.method(HttpClient.prototype, "post", async (path: string, body?: string | URLSearchParams) => {
    assert.equal(path, "/vendas/grupos");
    return { ok: true, text: async () => groupListingFixture(Number(new URLSearchParams(body).get("grupofrm"))) } as never;
  });
  t.mock.method(HttpClient.prototype, "get", async (path: string) => {
    assert.ok(path.endsWith("/S"));
    const group = Number(path.split("/").at(-2));
    const html = groupDetailsFixture(wrongGroup ? 1111 : group);
    return { ok: true, text: async () => failRules ? html.replace("FIDELIDADE 30%", "FIDELIDADE ESPECIAL") : html } as never;
  });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "fixture.supabase.co");
    if (url.pathname === "/rest/v1/bd_producao") return new Response(JSON.stringify([{ nr_grupo: 9999 }, { nr_grupo: "9999" }]));
    if (url.pathname === "/rest/v1/grupos" && init?.method === "GET") return new Response(JSON.stringify(stored));
    if (url.pathname === "/rest/v1/grupos") {
      groupWrites++;
      stored = JSON.parse(String(init?.body));
      assert.equal("regras_texto" in stored[0], false);
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
  assert.equal((await runGroupSync({}, "fixture-run", logger)).successCount, 1);
  assert.equal(logs[0].trigger_run_id, "fixture-run");
  stored[0].proxima_assembleia_em = "2026-11-23T19:00:00+00:00";
  assert.equal((await runGroupSync({}, "fixture-run-2", logger)).changedCount, 0);
  const previousRules = structuredClone(stored[0].regras_assembleias);
  failRules = true;
  assert.equal((await runGroupSync({}, "fixture-run-3", logger)).partialCount, 1);
  assert.deepEqual(stored[0].regras_assembleias, previousRules);
  wrongGroup = true;
  const before = groupWrites;
  assert.equal((await runGroupSync({}, "fixture-run-4", logger)).errorCount, 1);
  assert.equal(groupWrites, before);
  assert.equal(logs.at(-1)!.status, "falha");
  wrongGroup = false;
  failAudit = true;
  await assert.rejects(runGroupSync({}, "fixture-run-5", logger), /database write failed/);
  await assert.rejects(runGroupSync({ groups: [0] }, undefined, logger), /requires groups/);
});
