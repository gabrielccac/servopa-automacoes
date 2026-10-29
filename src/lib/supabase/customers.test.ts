import assert from "node:assert/strict";
import test from "node:test";
import { fetchActiveRecentContemplationCustomers, fetchUpcomingPaymentReminderCustomers, type Customer } from "./customers.js";
import { runTextReminderWorkflow } from "../reminders/shared.js";
import { getConfig } from "../config.js";

function configureFixtureEnvironment() {
  const environment = {
    SERVOPA_CPF_CNPJ: "fixture", SERVOPA_SENHA: "fixture",
    SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fixture",
    ZAPI_INSTANCE_ID: "fixture", ZAPI_INSTANCE_TOKEN: "fixture", ZAPI_CLIENT_TOKEN: "fixture",
  };
  for (const [name, value] of Object.entries(environment)) process.env[name] = value;
}

test("payment selection excludes credit cards from the database, including manual payloads", async (t) => {
  configureFixtureEnvironment();
  const customer = (contract: string, method: string | null, day = 16): Customer => ({
    nr_contrato: contract, ds_meio_pagamento: method, nr_diavenc: day,
    nm_consorciado: "Fixture", cd_whatsapp: "5511999990001", nr_cota: "0001-1",
    nr_grupo: "1000", dt_cancelamento: null, dt_contemplacao: null, dt_nasc: null,
  });
  const rows = [
    customer("CARD", "CARTAO DE CREDITO"),
    customer("ACCENTED", "  cartão   de crédito  "),
    customer("PIX", "PIX"), customer("BOLETO", "BOLETO BANCARIO"),
    customer("LINK", "LINK DE PAGAMENTO"), customer("EMPTY", null),
    customer("OTHER-DAY", "PIX", 8),
  ];
  const requests: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.ok(url.searchParams.get("select")?.includes("ds_meio_pagamento"));
    return new Response(JSON.stringify(rows));
  });
  const scheduled = await fetchUpcomingPaymentReminderCustomers("2026-10-14");
  assert.deepEqual(scheduled.map((row) => row.nr_contrato), ["PIX", "BOLETO", "LINK", "EMPTY"]);
  const manual = await fetchUpcomingPaymentReminderCustomers("2026-10-14", [
    customer("CARD", "PIX"), customer("ACCENTED", null),
    customer("LINK", null), customer("UNKNOWN", "PIX"),
  ]);
  assert.deepEqual(manual.map((row) => row.nr_contrato), ["LINK"]);
  assert.equal(manual[0].ds_meio_pagamento, "LINK DE PAGAMENTO");
  assert.equal(requests[0].searchParams.get("dt_cancelamento"), "is.null");
  assert.equal(requests[1].searchParams.get("nr_contrato"), 'in.("CARD","ACCENTED","LINK","UNKNOWN")');
  const fetchCount = requests.length;
  assert.deepEqual(await fetchUpcomingPaymentReminderCustomers("2026-10-14", []), []);
  assert.equal(requests.length, fetchCount);
});

test("contemplation includes today and yesterday across month/year boundaries", async (t) => {
  configureFixtureEnvironment();
  let dates = ["2026-10-23", "2026-10-22", "2026-10-21", "2026-10-24", null];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("dt_cancelamento"), "is.null");
    return new Response(JSON.stringify(dates.map((dt_contemplacao) => ({ dt_contemplacao }))));
  });
  assert.deepEqual((await fetchActiveRecentContemplationCustomers("2026-10-23"))
    .map((row) => row.dt_contemplacao), ["2026-10-23", "2026-10-22"]);
  dates = ["2026-12-31", "2027-01-01", "2026-12-30"];
  assert.deepEqual((await fetchActiveRecentContemplationCustomers("2027-01-01"))
    .map((row) => row.dt_contemplacao), ["2026-12-31", "2027-01-01"]);
  dates = ["2028-02-29", "2028-03-01", "2028-02-28"];
  assert.deepEqual((await fetchActiveRecentContemplationCustomers("2028-03-01"))
    .map((row) => row.dt_contemplacao), ["2028-02-29", "2028-03-01"]);
});

test("late contemplation uses event date for logs and does not send again on the next day", async (t) => {
  configureFixtureEnvironment();
  const customer = { nr_contrato: "FIXTURE", dt_contemplacao: "2026-10-22" };
  const logs: Record<string, unknown>[] = [];
  let sends = 0;
  let rejectSend = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/reminder_logs") {
      if (init?.method === "POST") {
        const [row] = JSON.parse(String(init.body));
        assert.equal(row.reference_date, "2026-10-22");
        assert.equal(row.idempotency_key, "contemplation:FIXTURE:2026-10-22");
        logs.splice(0, logs.length, row);
        return new Response(JSON.stringify([row]));
      }
      assert.equal(url.searchParams.get("idempotency_key"), 'in.("contemplation:FIXTURE:2026-10-22")');
      return new Response(JSON.stringify(logs));
    }
    assert.equal(url.hostname, "zapi.fixture");
    if (rejectSend) return new Response("unavailable", { status: 503 });
    sends++;
    return new Response(JSON.stringify({ messageId: "fixture-message" }));
  });
  const run = (day: string) => runTextReminderWorkflow({
    payload: { asOfDate: day }, requiredCustomerKeys: ["nr_contrato"],
    reminderType: "contemplation",
    referenceDate: (_day, row) => row.dt_contemplacao,
    logger: { log: () => undefined }, label: "fixture",
    fetchCustomers: async () => [customer], buildMessage: () => "fixture",
    getContract: (row) => row.nr_contrato, getName: () => "Fixture",
    getPhoneValue: () => "5511999990001",
    zapiConfig: { ...getConfig().zapi, baseUrl: "https://zapi.fixture" },
  });
  assert.equal((await run("2026-10-22")).sentCount, 1);
  const nextDay = await run("2026-10-23");
  assert.equal(nextDay.alreadyProcessedCount, 1);
  assert.equal(sends, 1);

  logs.length = 0;
  rejectSend = true;
  assert.equal((await run("2026-10-22")).errorCount, 1);
  assert.equal(logs[0].status, "failed");
  rejectSend = false;
  assert.equal((await run("2026-10-23")).sentCount, 1);
  assert.equal(logs[0].status, "sent");
  assert.equal(sends, 2);
});
