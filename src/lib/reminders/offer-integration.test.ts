import assert from "node:assert/strict";
import test from "node:test";
import { chooseOfferForCustomer } from "../../trigger/offer-reminder.js";
import type { CustomerLanceOptionsResult } from "../servopa/customer-lances.js";
import type { ReminderLogRow } from "../supabase/reminder-logs.js";

test("sent offers do not replace the recorded lance; unknown states and other-group tiers are blocked", () => {
  const customer = { nr_contrato: "FIXTURE", nm_consorciado: "Fixture", cd_whatsapp: "5511999990001", nr_cota: "1-1", nr_grupo: "1577", gp_fidelidade: true, dt_cancelamento: null, tp_lance: null };
  const validation = { availableOptions: [10, 15, 20, 30].map((pct_lance) => ({ lance_type: "FIDELIDADE", pct_lance })) } as CustomerLanceOptionsResult;
  const config = { nr_grupo: 1577, hierarquia_fidelidade: [30, 20, 10] };
  const logs = new Map<string, ReminderLogRow[]>([["FIXTURE", [{ reminder_type: "offer_fidelidade_30", status: "sent" } as ReminderLogRow]]]);
  const unknown = chooseOfferForCustomer(customer, null, validation, logs, config);
  assert.equal(unknown.status, "skipped");
  if (unknown.status === "skipped") assert.equal(unknown.reason, "unknown_current_lance");
  const candidate = chooseOfferForCustomer(customer, { nr_contrato: "FIXTURE", tp_lance: "FIDELIDADE", pct_lance: 30 }, validation, logs, config);
  assert.equal(candidate.status, "candidate");
  if (candidate.status === "candidate") assert.equal(candidate.offer.pctLance, 10);
  logs.get("FIXTURE")!.push({ reminder_type: "offer_fidelidade_10", status: "sent" } as ReminderLogRow);
  const duplicate = chooseOfferForCustomer(customer, { nr_contrato: "FIXTURE", tp_lance: "FIDELIDADE", pct_lance: 30 }, validation, logs, config);
  assert.equal(duplicate.status, "skipped");
  if (duplicate.status === "skipped") assert.equal(duplicate.reason, "already_sent_offer");
});
