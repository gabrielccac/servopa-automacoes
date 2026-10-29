import { logger, task } from "@trigger.dev/sdk";
import { getConfig } from "../lib/config.js";
import { buildOfferReminderIdempotencyKey } from "../lib/idempotency.js";
import {
  parseReminderPayload,
  sendReminderMessage,
  sleep,
  type ReminderTaskInput,
} from "../lib/reminders/shared.js";
import { normalizePhone } from "../lib/parsers.js";
import {
  getCustomerLanceOptions,
  type CustomerLanceOptionsResult,
} from "../lib/servopa/customer-lances.js";
import type { ServopaCustomerRef } from "../lib/servopa/customer-context.js";
import { HttpClient } from "../lib/servopa/http-client.js";
import { getTodayIsoDateInSaoPaulo } from "../lib/supabase/customers.js";
import {
  fetchOfferGroupConfigs,
  fetchOfferReminderCandidates,
  fetchLanceStatesByContracts,
  type LanceStateRow,
  type OfferReminderCandidate,
} from "../lib/supabase/offer-reminder.js";
import {
  fetchReminderLogs,
  isTerminalReminderLogStatus,
  type ReminderLogRow,
  upsertReminderLog,
} from "../lib/supabase/reminder-logs.js";
import { getSendResponseExternalId, getZApiConfig, type ZApiButtonAction } from "../lib/whatsapp/zapi.js";
import { formatCustomerFirstName } from "../lib/whatsapp/templates.js";
import { getNextOfferStep, offerPrecheck, type OfferStep, type OfferGroupConfig } from "../lib/reminders/offer-policy.js";
export { getNextOfferStep } from "../lib/reminders/offer-policy.js";

type OfferReminderTaskInput = ReminderTaskInput<OfferReminderCandidate>;

const OFFER_CUSTOMER_KEYS = ["nr_contrato", "nr_cota", "nr_grupo"];

type OfferReminderDecision =
  | {
      customer: OfferReminderCandidate;
      status: "candidate";
      offer: OfferStep;
      reminderType: string;
      reason: "progression_upgrade";
      currentLance: LanceStateRow | null;
      validation: CustomerLanceOptionsResult;
    }
  | {
      customer: OfferReminderCandidate;
      status: "skipped";
      reason:
        | "already_at_last_tier"
        | "already_sent_offer"
        | "next_offer_not_available"
        | "unsupported_current_lance_type"
        | "unknown_current_lance"
        | "group_rules_unavailable"
        | "group_has_no_fidelidade"
        | "current_lance_not_in_group_hierarchy";
      currentLance: LanceStateRow | null;
      validation?: CustomerLanceOptionsResult;
    }
  | {
      customer: OfferReminderCandidate;
      status: "failed";
      error: string;
      currentLance: LanceStateRow | null;
    };

function toCustomerRef(customer: OfferReminderCandidate): ServopaCustomerRef {
  const grupo = String(customer.nr_grupo || "").trim();
  const cota = String(customer.nr_cota || "").trim();
  const nrContrato = String(customer.nr_contrato || "").trim();
  const [plano, digito] = cota.split("-");

  return {
    grupo,
    plano: String(plano || "").trim(),
    digito: String(digito || "").trim(),
    nr_contrato: nrContrato,
  };
}

function hasTerminalLogForReminderType(
  logsByContract: Map<string, ReminderLogRow[]>,
  contract: string,
  reminderType: string,
): boolean {
  return (logsByContract.get(contract) ?? []).some(
    (row) => row.reminder_type === reminderType && isTerminalReminderLogStatus(row.status),
  );
}

export function chooseOfferForCustomer(
  customer: OfferReminderCandidate,
  currentLance: LanceStateRow | null,
  validation: CustomerLanceOptionsResult,
  logsByContract: Map<string, ReminderLogRow[]>,
  group: OfferGroupConfig,
): OfferReminderDecision {
  const contract = String(customer.nr_contrato || "").trim();
  const reason = offerPrecheck(currentLance, group);
  const offer = reason ? null : getNextOfferStep(currentLance, validation.availableOptions, group.hierarquia_fidelidade);
  if (!offer) {
    return { customer, status: "skipped", reason: reason ?? "next_offer_not_available", currentLance, validation };
  }

  if (hasTerminalLogForReminderType(logsByContract, contract, offer.reminderType)) {
    return {
      customer,
      status: "skipped",
      reason: "already_sent_offer",
      currentLance,
      validation,
    };
  }

  return {
    customer,
    status: "candidate",
    offer,
    reminderType: offer.reminderType,
    reason: "progression_upgrade",
    currentLance,
    validation,
  };
}

function summarizeDecision(result: OfferReminderDecision) {
  if (result.status === "failed") {
    return {
      customer: result.customer,
      status: result.status,
      error: result.error,
      currentLance: result.currentLance,
    };
  }

  if (result.status === "skipped") {
    return {
      customer: result.customer,
      status: result.status,
      reason: result.reason,
      currentLance: result.currentLance,
      availableOptions:
        result.validation?.availableOptions.map((option) => ({
          lance_type: option.lance_type,
          pct_lance: option.pct_lance,
          vl_lance: option.vl_lance,
          periodo_meses: option.periodo_meses,
        })) ?? [],
    };
  }

  return {
    customer: result.customer,
    status: result.status,
    offerType: result.offer.lanceType,
    offerPct: result.offer.pctLance,
    reminderType: result.reminderType,
    reason: result.reason,
    currentLance: result.currentLance,
    availableOptions: result.validation.availableOptions.map((option) => ({
      lance_type: option.lance_type,
      pct_lance: option.pct_lance,
      vl_lance: option.vl_lance,
      periodo_meses: option.periodo_meses,
    })),
  };
}

interface OfferCandidateGroup {
  phone: string | null;
  customerName: string | null;
  offer: OfferStep;
  reason: "progression_upgrade";
  candidates: Extract<OfferReminderDecision, { status: "candidate" }>[];
}

function groupOfferCandidates(
  candidates: Extract<OfferReminderDecision, { status: "candidate" }>[],
): OfferCandidateGroup[] {
  const groups = new Map<string, OfferCandidateGroup>();

  for (const candidate of candidates) {
    const phone = normalizePhone(candidate.customer.cd_whatsapp);
    const key = [
      phone ?? `missing:${candidate.customer.nr_contrato}`,
      candidate.reminderType,
      candidate.reason,
    ].join("|");
    const existing = groups.get(key);

    if (existing) {
      existing.candidates.push(candidate);
      continue;
    }

    groups.set(key, {
      phone,
      customerName: candidate.customer.nm_consorciado,
      offer: candidate.offer,
      reason: candidate.reason,
      candidates: [candidate],
    });
  }

  return [...groups.values()];
}

function toOfferButtonContract(customer: OfferReminderCandidate) {
  const rawGrupo = String(customer.nr_grupo ?? "").trim();
  const nrGrupo = rawGrupo && Number.isInteger(Number(rawGrupo)) ? Number(rawGrupo) : null;

  return {
    nr_contrato: String(customer.nr_contrato ?? "").trim(),
    nr_cota: String(customer.nr_cota ?? "").trim() || null,
    nr_grupo: nrGrupo,
    nm_consorciado: String(customer.nm_consorciado ?? "").trim() || null,
    dt_vencimento: null,
  };
}

function buildOfferButtonId(
  action: "accept_offer_group" | "offer_questions",
  group: OfferCandidateGroup,
): string {
  const payload = {
    v: 1,
    action,
    tp_lance: group.offer.lanceType,
    pct_lance: group.offer.pctLance,
    diluicao_em_parcelas: true,
    contratos: group.candidates.map((candidate) => toOfferButtonContract(candidate.customer)),
  };

  return `offer|${encodeURIComponent(JSON.stringify(payload))}`;
}

function buildOfferMessage(group: OfferCandidateGroup): string {
  const contracts = group.candidates.map((candidate) => {
    const contract = candidate.customer.nr_contrato ?? "---";
    const cota = candidate.customer.nr_cota ?? "---";
    return `• ${contract} — Cota ${cota}`;
  });
  const target = group.candidates.length === 1 ? "sua cota" : "suas cotas";
  const explanation = "Ao confirmar, atualizaremos seu lance automático para esta nova condição.";

  return [
    `Olá, ${formatCustomerFirstName(group.customerName)}! Tudo bem?`,
    "",
    `Temos uma oportunidade de Lance Fidelidade de ${group.offer.pctLance}% para ${target}:`,
    ...contracts,
    "",
    explanation,
    "",
    "Escolha uma opção abaixo:",
  ].join("\n");
}

function buildOfferButtons(group: OfferCandidateGroup): ZApiButtonAction[] {
  return [
    {
      id: buildOfferButtonId("accept_offer_group", group),
      type: "REPLY",
      label: "Quero participar",
    },
    {
      id: buildOfferButtonId("offer_questions", group),
      type: "REPLY",
      label: "Tirar dúvidas",
    },
  ];
}

export const offerReminder = task({
  id: "offer-reminder",
  maxDuration: 900,
  retry: { maxAttempts: 1 },
  queue: { concurrencyLimit: 1 },
  run: async (payload?: OfferReminderTaskInput) => {
    const { customers: payloadCustomers, dryRun, asOfDate } = parseReminderPayload(
      payload,
      OFFER_CUSTOMER_KEYS,
    );
    const referenceDate = asOfDate ?? getTodayIsoDateInSaoPaulo();
    const requestedContracts = [
      ...new Set(
        (payloadCustomers ?? [])
          .map((customer) => String(customer.nr_contrato || "").trim())
          .filter(Boolean),
      ),
    ];

    const initialCustomers =
      payloadCustomers ??
      (await fetchOfferReminderCandidates(
        requestedContracts.length > 0 ? { contracts: requestedContracts } : undefined,
      ));

    const contracts = initialCustomers
      .map((customer) => String(customer.nr_contrato || "").trim())
      .filter(Boolean);
    const lanceRows = await fetchLanceStatesByContracts(contracts);
    const lanceByContract = new Map<string, LanceStateRow>(
      lanceRows
        .filter((row): row is LanceStateRow & { nr_contrato: string } => Boolean(row.nr_contrato))
        .map((row) => [row.nr_contrato, row]),
    );
    const reminderLogs = await fetchReminderLogs({ contracts });
    const reminderLogsByContract = new Map<string, ReminderLogRow[]>();

    for (const row of reminderLogs) {
      const contract = String(row.nr_contrato || "").trim();
      const existingRows = reminderLogsByContract.get(contract) ?? [];
      existingRows.push(row);
      reminderLogsByContract.set(contract, existingRows);
    }

    const groupConfigs = await fetchOfferGroupConfigs();
    const groupById = new Map(groupConfigs.map((group) => [group.nr_grupo, group]));
    const results: OfferReminderDecision[] = [];
    const customers = initialCustomers.filter((customer) => {
      const currentLance = lanceByContract.get(String(customer.nr_contrato ?? "").trim()) ?? null;
      const reason = offerPrecheck(currentLance, groupById.get(Number(customer.nr_grupo)));
      if (!reason) return true;
      results.push({ customer, status: "skipped", reason, currentLance });
      return false;
    });
    const terminalContracts = results.filter((result) => result.status === "skipped" && result.reason === "already_at_last_tier");
    logger.log("Offer reminder selection summary", {
      source: payloadCustomers ? "payload" : "database",
      fetchedCount: initialCustomers.length,
      filteredOutAlreadyAtLastTierCount: terminalContracts.length,
      selectedCount: customers.length,
      lanceRowCount: lanceRows.length,
      reminderLogCount: reminderLogs.length,
    });

    const client = new HttpClient({ ...getConfig().servopa, timeout: 30_000 });

    try {
      if (customers.length) await client.login();

      for (const customer of customers) {
        const contract = String(customer.nr_contrato || "").trim();
        const currentLance = lanceByContract.get(contract) ?? null;

        try {
          const validation = await getCustomerLanceOptions(client, toCustomerRef(customer));
          results.push(
            chooseOfferForCustomer(
              customer,
              currentLance,
              validation,
              reminderLogsByContract,
              groupById.get(Number(customer.nr_grupo))!,
            ),
          );
        } catch (error) {
          results.push({
            customer,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            currentLance,
          });
        }
      }
    } finally {
      await client.logout().catch(() => undefined);
      await client.close();
    }

    const candidateResults = results.filter((result) => result.status === "candidate");
    const skippedResults = results.filter((result) => result.status === "skipped");
    const failedResults = results.filter((result) => result.status === "failed");
    const candidateGroups = groupOfferCandidates(candidateResults);
    const sendPlan = candidateGroups.map((group) => ({
      phone: group.phone,
      message: buildOfferMessage(group),
      buttonActions: buildOfferButtons(group),
      offerType: group.offer.lanceType,
      offerPct: group.offer.pctLance,
      contracts: group.candidates.map((candidate) => candidate.customer.nr_contrato),
    }));
    let sentMessageCount = 0;
    let sentContractCount = 0;
    let sendErrorCount = 0;
    let reminderLogCount = 0;
    let reminderLogErrorCount = 0;

    if (!dryRun) {
      const zapiConfig = getZApiConfig();

      for (const [groupIndex, group] of candidateGroups.entries()) {
        const plan = sendPlan[groupIndex];

        if (!group.phone) {
          sendErrorCount += group.candidates.length;
          logger.warn("Offer reminder skipped: missing WhatsApp", {
            contracts: plan.contracts,
          });
          if (groupIndex < candidateGroups.length - 1) {
            await sleep(1000);
          }
          continue;
        }

        try {
          const { sendResponse } = await sendReminderMessage(zapiConfig, {
            phone: group.phone,
            message: plan.message,
            buttonActions: plan.buttonActions,
            dryRun: false,
          });
          const externalMessageId = getSendResponseExternalId(sendResponse);
          const sentAt = new Date().toISOString();

          sentMessageCount += 1;
          sentContractCount += group.candidates.length;

          for (const candidate of group.candidates) {
            const contract = String(candidate.customer.nr_contrato ?? "").trim();

            try {
              await upsertReminderLog({
                idempotency_key: buildOfferReminderIdempotencyKey(
                  candidate.reminderType,
                  contract,
                ),
                nr_contrato: contract,
                nm_consorciado: candidate.customer.nm_consorciado,
                cd_whatsapp: candidate.customer.cd_whatsapp,
                reminder_type: candidate.reminderType,
                reference_date: referenceDate,
                status: "sent",
                message_body: plan.message,
                external_message_id: externalMessageId,
                last_error: null,
                sent_at: sentAt,
              });
              reminderLogCount += 1;
            } catch (error) {
              reminderLogErrorCount += 1;
              logger.error("Offer reminder sent but reminder log failed", {
                contract,
                reminderType: candidate.reminderType,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        } catch (error) {
          sendErrorCount += group.candidates.length;
          logger.error("Offer reminder send failed", {
            phone: group.phone,
            contracts: plan.contracts,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        if (groupIndex < candidateGroups.length - 1) {
          await sleep(1000);
        }
      }
    }

    return {
      workflow: "offer-reminder",
      policyVersion: "group-hierarchy-v1",
      groupConfigs,
      source: payloadCustomers ? "payload" : "database",
      dryRun,
      referenceDate,
      fetchedCount: initialCustomers.length,
      filteredOutAlreadyAtLastTierCount: terminalContracts.length,
      selectedCount: customers.length,
      candidateCount: candidateResults.length,
      skippedCount: skippedResults.length,
      errorCount: failedResults.length,
      sendMessageCount: candidateGroups.length,
      sentMessageCount,
      sentContractCount,
      sendErrorCount,
      reminderLogCount,
      reminderLogErrorCount,
      sendPlan,
      candidatesByOffer: Object.fromEntries([...new Set(candidateResults.map((result) => result.offer.pctLance))]
        .map((pct) => [`fidelidade${pct}`, candidateResults.filter((result) => result.offer.pctLance === pct).length])),
      skipReasons: Object.fromEntries([...new Set(skippedResults.map((result) => result.reason))]
        .map((reason) => [reason, skippedResults.filter((result) => result.reason === reason).length])),
      results: results.map((result) => ({ ...summarizeDecision(result),
        groupHierarchy: groupById.get(Number(result.customer.nr_grupo))?.hierarquia_fidelidade ?? null })),
    };
  },
});
