import test from "node:test";
import assert from "node:assert/strict";
import { parseSemicolonCsv } from "./csv.js";
import { preserveOrBackfillWhatsapp } from "./supabase/daily-sync.js";
import {
  parseAsOfDate,
  parseReminderPayload,
  runTextReminderWorkflow,
  sendReminderMessage,
} from "./reminders/shared.js";
import { getBirthdayReminderIdentity } from "../trigger/birthday-reminder.js";
import { resolveReminderStage } from "../trigger/overdue-payment-reminder.js";
import { getNextOfferStep } from "../trigger/offer-reminder.js";
import { buildOfferReminderIdempotencyKey } from "./idempotency.js";
import { normalizeRequestedDtVenc } from "../trigger/submit-bid.js";
import { getCustomerLanceOptions } from "./servopa/customer-lances.js";
import { getCustomerPaymentInfo, refreshCustomerPaymentLinks } from "./servopa/customer-payment-info.js";
import type { HttpClient } from "./servopa/http-client.js";
import type { OverduePaymentRecord } from "./supabase/customers.js";
import { buildDailyExecutionSummary } from "../trigger/daily-orchestrator.js";

test("boleto links must return a PDF before any WhatsApp send; dry runs make no requests", async (t) => {
  const boletoUrl = "https://www.consorcioservopa.com.br/docparser/view/fixture";
  const input = {
    phone: "5511999990001", message: "Fixture reminder", dryRun: false,
    buttonActions: [{ id: "1", type: "URL" as const, label: "Boleto", url: boletoUrl }],
  };
  const config = {
    baseUrl: "https://zapi.fixture", instanceId: "fixture", instanceToken: "fixture", clientToken: "fixture",
    executionSummaryPhone: null, restoreDeliveryWebhookUrl: null, deliveryWaitTimeout: "5m",
  };
  let body = "Erro";
  let status = 200;
  let sendCount = 0;
  const fetch = t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === boletoUrl) {
      assert.equal(init?.headers, undefined);
      return new Response(body, { status });
    }
    assert.equal(String(url), "https://zapi.fixture/instances/fixture/token/fixture/send-button-actions");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      phone: input.phone, message: input.message, buttonActions: input.buttonActions,
    });
    sendCount++;
    return new Response(JSON.stringify({ messageId: "fixture-message" }));
  });
  await assert.rejects(sendReminderMessage(config, input), /response is not a PDF/);
  assert.equal(sendCount, 0);
  body = "<html>Login</html>";
  await assert.rejects(sendReminderMessage(config, input), /response is not a PDF/);
  status = 404;
  await assert.rejects(sendReminderMessage(config, input), /HTTP 404/);
  assert.equal(sendCount, 0);
  status = 200;
  body = "%PDF-1.7\nfixture";
  assert.equal((await sendReminderMessage(config, input)).sendMode, "button-actions");
  assert.equal(sendCount, 1);
  const callsBeforeDryRun = fetch.mock.callCount();
  await sendReminderMessage(config, { ...input, dryRun: true });
  assert.equal(fetch.mock.callCount(), callsBeforeDryRun);
});

test("invalid boleto is extracted again once and only validated replacement links are sent", async (t) => {
  const config = {
    baseUrl: "https://zapi.fixture", instanceId: "fixture", instanceToken: "fixture", clientToken: "fixture",
    executionSummaryPhone: null, restoreDeliveryWebhookUrl: null, deliveryWaitTimeout: "5m",
  };
  const oldUrl = "https://boleto.fixture/old";
  const newUrl = "https://boleto.fixture/new";
  const replacement = [
    { id: "1", type: "URL" as const, label: "Boleto", url: newUrl },
    { id: "2", type: "URL" as const, label: "Pix", url: "https://pix.fixture/new" },
  ];
  let refreshed = 0;
  let sent = 0;
  let replacementValid = true;
  const checked: string[] = [];
  const input = {
    phone: "5511999990001", message: "Fixture", dryRun: false,
    buttonActions: [{ id: "1", type: "URL" as const, label: "Boleto", url: oldUrl }],
    refreshButtonActions: async () => { refreshed++; return replacement; },
  };
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith("https://boleto.fixture/")) {
      checked.push(String(url));
      return new Response(String(url) === newUrl && replacementValid ? "%PDF-1.7\nfixture" : "Erro");
    }
    assert.equal(String(url), "https://zapi.fixture/instances/fixture/token/fixture/send-button-actions");
    assert.deepEqual(JSON.parse(String(init?.body)).buttonActions, replacement);
    sent++;
    return new Response(JSON.stringify({ messageId: "fixture-message" }));
  });
  await sendReminderMessage(config, input);
  assert.deepEqual(checked, [oldUrl, newUrl]);
  assert.equal(refreshed, 1);
  assert.equal(sent, 1);

  replacementValid = false;
  await assert.rejects(sendReminderMessage(config, input), /not a PDF/);
  assert.equal(refreshed, 2);
  assert.equal(sent, 1);
  await assert.rejects(sendReminderMessage(config, {
    ...input, refreshButtonActions: async () => [],
  }), /boleto URL is missing/);
  await assert.rejects(sendReminderMessage(config, {
    ...input, refreshButtonActions: async () => { throw new Error("extrato unavailable"); },
  }), /extrato unavailable/);
  assert.equal(sent, 1);
  await sendReminderMessage(config, { ...input, dryRun: true });
  assert.equal(refreshed, 2);
});

test("re-extraction preserves the exact contract, installment and charge type", async () => {
  const customer = { nr_contrato: "FIXTURE1", grupo: "1", plano: "2", digito: "3" };
  let contract = customer.nr_contrato;
  let rows = [["12", "Normal"], ["13", "Normal"], ["12", "Diluicao"]];
  let calls = 0;
  const client = {
    get: async (path: string) => {
      calls++;
      if (path !== "/vendas/extrato") {
        assert.equal(path, "/vendas/painel/1/3/2/FIXTURE1/V");
        return new Response("");
      }
      return new Response(`<div class="main-info-block-col"><span>Contrato</span><strong>${contract}</strong></div>
        <div class="block"><h2>Parcelas Emitidas</h2><table><tbody>${rows.map(([number, type]) =>
          `<tr><td>${number}</td><td>${type}</td>${"<td>100,00</td>".repeat(6)}
          <td><a href="/boleto/${number}/${type}/${calls}">Gerar Boleto</a>
          <a data-src="/pix/${number}/${type}/${calls}">Pagar com PIX</a></td></tr>`).join("")}</tbody></table></div>`);
    },
  } as unknown as HttpClient;
  const info = await getCustomerPaymentInfo(client, customer);
  const original = info.boletos[0];
  await refreshCustomerPaymentLinks(client, customer, original);
  assert.equal(original.boleto_url, "https://www.consorcioservopa.com.br/boleto/12/Normal/4");
  assert.equal(original.pix_url, "https://www.consorcioservopa.com.br/pix/12/Normal/4");
  rows = [["13", "Normal"], ["12", "Diluicao"]];
  await assert.rejects(refreshCustomerPaymentLinks(client, customer, original), /missing or ambiguous/);
  rows = [["12", "Normal"], ["12", "Normal"]];
  await assert.rejects(refreshCustomerPaymentLinks(client, customer, original), /missing or ambiguous/);
  contract = "OTHER";
  await assert.rejects(refreshCustomerPaymentLinks(client, customer, original), /context mismatch/);
  assert.equal(original.boleto_url, "https://www.consorcioservopa.com.br/boleto/12/Normal/4");
});

test("parseSemicolonCsv keeps quoted semicolons together", () => {
  const rows = parseSemicolonCsv('NOME;OBS\n"Ana";"linha;com;separador"');

  assert.deepEqual(rows, [
    {
      NOME: "Ana",
      OBS: "linha;com;separador",
    },
  ]);
});

test("parseSemicolonCsv unescapes doubled quotes", () => {
  const rows = parseSemicolonCsv('NOME;OBS\n"Ana";"disse ""oi"""');

  assert.equal(rows[0]?.OBS, 'disse "oi"');
});

test("parseReminderPayload only treats direct customer payloads as valid when all required keys exist", () => {
  const parsed = parseReminderPayload(
    { nr_contrato: "123" } as { nr_contrato: string; cd_whatsapp?: string },
    ["nr_contrato", "cd_whatsapp"],
  );

  assert.equal(parsed.customers, null);
  assert.equal(parsed.dryRun, false);
  assert.equal(parsed.respectIdempotency, false);
});

test("parseReminderPayload reads wrapper flags and customer arrays", () => {
  const parsed = parseReminderPayload(
    {
      customers: [{ nr_contrato: "123", cd_whatsapp: "55999999999" }],
      dryRun: true,
      respectIdempotency: true,
      asOfDate: "2026-07-28",
    },
    ["nr_contrato", "cd_whatsapp"],
  );

  assert.equal(parsed.customers?.length, 1);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.respectIdempotency, true);
  assert.equal(parsed.asOfDate, "2026-07-28");
});

test("parseAsOfDate rejects malformed and impossible calendar dates", () => {
  assert.equal(parseAsOfDate("2026-02-28"), "2026-02-28");
  assert.throws(() => parseAsOfDate("2026-02-30"), /valid calendar date/);
  assert.throws(() => parseAsOfDate("28-07-2026"), /YYYY-MM-DD/);
});

test("text reminder dry run never sends, logs, or fetches live customers", async () => {
  let buildDate: string | null = null;
  const result = await runTextReminderWorkflow({
    payload: {
      customers: [{ contract: "123", phone: "55999999999" }],
      dryRun: true,
      asOfDate: "2026-07-28",
    },
    requiredCustomerKeys: ["contract", "phone"],
    reminderType: "test",
    referenceDate: (asOfDate) => {
      buildDate = asOfDate;
      return asOfDate ?? "missing";
    },
    logger: { log: () => undefined },
    label: "test reminder",
    fetchCustomers: async () => {
      throw new Error("dry run should not fetch live customers");
    },
    buildMessage: () => "fixture message",
    getContract: (customer) => customer.contract,
    getName: () => "Fixture",
    getPhoneValue: (customer) => customer.phone,
    zapiConfig: {} as never,
  });

  assert.equal(buildDate, "2026-07-28");
  assert.equal(result.dryRun, true);
  assert.equal(result.dryRunCount, 1);
  assert.equal(result.sentCount, 0);
  assert.equal(result.errorCount, 0);
});

test("daily sync preserves curated WhatsApp and backfills only an empty value", () => {
  assert.equal(
    preserveOrBackfillWhatsapp("5511999990001", "5511888880001"),
    "5511999990001",
  );
  assert.equal(
    preserveOrBackfillWhatsapp("", "5511888880001"),
    "5511888880001",
  );
  assert.equal(preserveOrBackfillWhatsapp(null, null), null);
});

test("birthday reminder dedupes by cpf before contract", () => {
  assert.equal(
    getBirthdayReminderIdentity({
      nr_contrato: "FIXTURE-BIRTHDAY-1",
      nm_consorciado: "CLIENTE DE TESTE",
      cd_whatsapp: "5511999990001",
      dt_cancelamento: null,
      dt_nasc: "1994-07-07",
      nr_cota: "0903-8",
      dt_contemplacao: null,
      nr_diavenc: 16,
      nr_grupo: "1571",
      nm_cpfcnpj_consorciado: "000.000.000-00",
    }),
    "00000000000",
  );
});

test("normalizeRequestedDtVenc accepts valid day-of-month payload values", () => {
  assert.equal(normalizeRequestedDtVenc(8), 8);
  assert.equal(normalizeRequestedDtVenc("8"), 8);
  assert.equal(normalizeRequestedDtVenc("31"), 31);
  assert.equal(normalizeRequestedDtVenc(0), null);
  assert.equal(normalizeRequestedDtVenc("32"), null);
});

test("Fixo 15 is not treated as Fidelidade 15", async () => {
  const client = {
    get: async (path: string) =>
      new Response(
        path === "/vendas/lances"
          ? `
            <div class="current-info-data"><span>Contrato: FIXTURE-LANCE-1</span></div>
            <div class="switcher-tab">
              <h3 class="title">Lance Fixo</h3>
              <input name="tx_lanfix" value="15" />
              <input name="vl_lanfix" value="68.091,21" />
            </div>
          `
          : "<html></html>",
        { status: 200 },
      ),
  };

  const result = await getCustomerLanceOptions(client as never, {
    grupo: "1",
    plano: "1",
    digito: "1",
    nr_contrato: "FIXTURE-LANCE-1",
  });

  assert.equal(result.hasFidelidade15, false);
  assert.equal(result.hasFidelidade30, false);
  assert.deepEqual(result.availableOptions.map((option) => option.lance_type), ["FIXO"]);
});

test("offer selection only returns the highest available Fidelidade level", () => {
  const available = (options: Array<["FIXO" | "FIDELIDADE", 15 | 30]>) =>
    options.map(([lance_type, pct_lance]) => ({ lance_type, pct_lance }));

  const choose = (current: Parameters<typeof getNextOfferStep>[0], options: Parameters<typeof getNextOfferStep>[1]) =>
    getNextOfferStep(current, options, [30, 15]);
  assert.equal(choose(null, available([["FIDELIDADE", 30]])), null);
  assert.deepEqual(
    choose(
      { tp_lance: "FIXO", pct_lance: 30 },
      available([["FIXO", 15], ["FIDELIDADE", 30]]),
    ),
    {
      lanceType: "FIDELIDADE",
      pctLance: 30,
      reminderType: "offer_fidelidade_30",
    },
  );
  assert.deepEqual(
    choose({ tp_lance: "FIXO", pct_lance: 30 }, available([["FIXO", 15]])),
    null,
  );
  assert.deepEqual(choose({ tp_lance: "FIXO", pct_lance: 15 }, available([["FIDELIDADE", 30]])), {
    lanceType: "FIDELIDADE",
    pctLance: 30,
    reminderType: "offer_fidelidade_30",
  });
  assert.deepEqual(choose({ tp_lance: "FIDELIDADE", pct_lance: 30 }, available([["FIDELIDADE", 15]])), {
    lanceType: "FIDELIDADE",
    pctLance: 15,
    reminderType: "offer_fidelidade_15",
  });
  assert.equal(choose({ tp_lance: "FIDELIDADE", pct_lance: 15 }, available([["FIDELIDADE", 15]])), null);
});

test("offer reminder idempotency stays stable across run dates", () => {
  assert.equal(
    buildOfferReminderIdempotencyKey("offer_fidelidade_30", "FIXTURE-OFFER-1"),
    buildOfferReminderIdempotencyKey("offer_fidelidade_30", "FIXTURE-OFFER-1"),
  );
  assert.notEqual(
    buildOfferReminderIdempotencyKey("offer_fidelidade_30", "FIXTURE-OFFER-1"),
    buildOfferReminderIdempotencyKey("offer_fidelidade_15", "FIXTURE-OFFER-1"),
  );
});

test("overdue reminders run 1, 7, and 14 days after the first occurrence", () => {
  const record: OverduePaymentRecord = {
    nr_contrato: "123",
    nr_cota: "1000.01-1",
    nm_consorciado: "Ana",
    cd_whatsapp: "55999999999",
    dt_vc: null,
    qt_pgo: null,
    qt_atr: null,
    vl_percent_mensal: null,
    vl_percent_difer: null,
    vl_atraso: null,
    dt_ultima_ocorrencia: null,
    dt_primeira_ocorrencia: "2026-07-01",
    st_ativo: true,
  };

  assert.equal(resolveReminderStage(record, "2026-07-02")?.overdueDay, 1);
  assert.equal(resolveReminderStage(record, "2026-07-08")?.overdueDay, 7);
  assert.equal(resolveReminderStage(record, "2026-07-15")?.overdueDay, 14);
  assert.equal(resolveReminderStage(record, "2026-07-29")?.label, "day_14_repeat");
  assert.equal(resolveReminderStage(record, "2026-07-30"), null);
});

test("daily execution summary includes every orchestrated stage", () => {
  const summary = buildDailyExecutionSummary({
    date: "2026-08-14",
    sync: {
      sync: {
        bdProducao: { rowCount: 141 },
        bdClientes: { rowCount: 95 },
        resultadoUltimasAssembleias: { rowCount: 2993 },
        disponivelParaVender: { rowCount: 10300 },
        inadimplentes: {
          rowCount: 3,
          insertedCount: 0,
          updatedCount: 3,
          closedCount: 0,
        },
        fidelidade: {
          fidelidadeSync: { updatedTrueCount: 0, updatedFalseCount: 0 },
        },
      },
    },
    activeVerification: {
      summary: {
        verifiedActiveCount: 95,
        customersToActivateCount: 2,
        customersToInactivateCount: 1,
      },
    },
    birthday: { sentCount: 1, skippedCount: 2, errorCount: 0 },
    contemplation: { sentCount: 3, skippedCount: 0, errorCount: 1 },
    payment: { sentCount: 4, skippedCount: 1, errorCount: 0, selectedCount: 5 },
    overdue: { sentCount: 6, skippedCount: 2, errorCount: 0, stageEligibleCount: 8 },
  });

  assert.match(summary, /Aniversários: 1 enviadas, 2 ignoradas, 0 falhas/);
  assert.match(summary, /Contemplações: 3 enviadas, 0 ignoradas, 1 falhas/);
  assert.match(summary, /Lembrete de pagamento: 4 enviadas, 1 ignoradas, 0 falhas, selecionadas: 5/);
  assert.match(summary, /Inadimplência: 6 enviadas, 2 ignoradas, 0 falhas, elegíveis: 8/);
});
