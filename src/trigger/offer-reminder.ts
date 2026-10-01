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
  type CustomerLanceOption,
} from "../lib/servopa/customer-lances.js";
import type { ServopaCustomerRef } from "../lib/servopa/customer-context.js";
import { HttpClient } from "../lib/servopa/http-client.js";
import { getTodayIsoDateInSaoPaulo } from "../lib/supabase/customers.js";
import {
  fetchOfferReminderCandidates,
  fetchLanceStatesByContracts,
  type LanceStateRow,
  type OfferReminderCandidate,
} from "../lib/supabase/offer-reminder.js";
import {
  fetchReminderLogs,
  isTerminalReminderLogStatus,
  OFFER_FIDELIDADE_15_REMINDER_TYPE,
  OFFER_FIDELIDADE_30_REMINDER_TYPE,
  type ReminderLogRow,
  upsertReminderLog,
} from "../lib/supabase/reminder-logs.js";
import { getSendResponseExternalId, getZApiConfig, type ZApiButtonAction } from "../lib/whatsapp/zapi.js";
import { formatCustomerFirstName } from "../lib/whatsapp/templates.js";

type OfferReminderTaskInput = ReminderTaskInput<OfferReminderCandidate>;

const OFFER_CUSTOMER_KEYS = ["nr_contrato", "nr_cota", "nr_grupo"];

type OfferLanceType = "FIDELIDADE";

export interface OfferStep {
  lanceType: OfferLanceType;
  pctLance: 15 | 30;
  reminderType: string;
}

const FIDELIDADE_OFFER_LEVELS: OfferStep[] = [
  {
    lanceType: "FIDELIDADE",
    pctLance: 30,
    reminderType: OFFER_FIDELIDADE_30_REMINDER_TYPE,
  },
  {
    lanceType: "FIDELIDADE",
    pctLance: 15,
    reminderType: OFFER_FIDELIDADE_15_REMINDER_TYPE,
  },
];

export interface TrackedLanceState {
  tp_lance: string | null;
  pct_lance: number | null;
}

type OfferReminderDecision =
  | {
      customer: OfferReminderCandidate;
      status: "candidate";
      offer: OfferStep;
      reminderType: string;
      reason: "first_offer" | "progression_upgrade";
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
        | "unsupported_current_lance_type";
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

function normalizeLanceType(value: string | null | undefined): string {
  return String(value || "").trim().toUpperCase();
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

function normalizeOfferType(value: string | null | undefined): OfferLanceType | null {
  const normalized = normalizeLanceType(value);
  return normalized === "FIDELIDADE" ? normalized : null;
}

export function getNextOfferStep(
  current: TrackedLanceState | null,
  availableOptions: Array<Pick<CustomerLanceOption, "lance_type" | "pct_lance">>,
): OfferStep | null {
  const currentType = normalizeLanceType(current?.tp_lance);
  if (current && currentType !== "FIXO" && currentType !== "FIDELIDADE") return null;

  const currentIndex =
    currentType === "FIDELIDADE"
      ? FIDELIDADE_OFFER_LEVELS.findIndex((step) => step.pctLance === current?.pct_lance)
      : -1;

  if (currentType === "FIDELIDADE" && currentIndex < 0) return null;

  const firstEligibleIndex = currentIndex + 1;
  return (
    [...FIDELIDADE_OFFER_LEVELS]
      .slice(firstEligibleIndex)
      .reverse()
      .find((step) =>
        availableOptions.some(
          (option) => option.lance_type === step.lanceType && option.pct_lance === step.pctLance,
        ),
      ) ?? null
  );
}

function isAtLastOfferStep(current: TrackedLanceState | null): boolean {
  return normalizeOfferType(current?.tp_lance) === "FIDELIDADE" && current?.pct_lance === 15;
}

function isRecognizedOfferState(current: TrackedLanceState | null): boolean {
  const currentType = normalizeLanceType(current?.tp_lance);
  return currentType === "FIXO" ||
    (currentType === "FIDELIDADE" && (current?.pct_lance === 15 || current?.pct_lance === 30));
}

function getOfferStepByReminderType(reminderType: string): OfferStep | null {
  return FIDELIDADE_OFFER_LEVELS.find((step) => step.reminderType === reminderType) ?? null;
}

function getLatestOfferLogState(logs: ReminderLogRow[]): TrackedLanceState | null {
  const latestLog = logs
    .filter(
      (row) =>
        isTerminalReminderLogStatus(row.status) &&
        getOfferStepByReminderType(row.reminder_type) !== null,
    )
    .sort((left, right) => {
      const leftDate = Date.parse(left.sent_at ?? left.updated_at ?? left.created_at);
      const rightDate = Date.parse(right.sent_at ?? right.updated_at ?? right.created_at);
      return rightDate - leftDate;
    })[0];

  const offer = latestLog ? getOfferStepByReminderType(latestLog.reminder_type) : null;
  return offer ? { tp_lance: offer.lanceType, pct_lance: offer.pctLance } : null;
}

function getTrackedLanceState(
  customer: OfferReminderCandidate,
  currentLance: LanceStateRow | null,
  reminderLogs: ReminderLogRow[],
): TrackedLanceState | null {
  if (currentLance) return currentLance;

  const loggedState = getLatestOfferLogState(reminderLogs);
  if (loggedState) return loggedState;

  if (customer.tp_lance) return { tp_lance: customer.tp_lance, pct_lance: null };

  return null;
}

function chooseOfferForCustomer(
  customer: OfferReminderCandidate,
  currentLance: LanceStateRow | null,
  validation: CustomerLanceOptionsResult,
  logsByContract: Map<string, ReminderLogRow[]>,
): OfferReminderDecision {
  const contract = String(customer.nr_contrato || "").trim();
  const trackedLance = getTrackedLanceState(
    customer,
    currentLance,
    logsByContract.get(contract) ?? [],
  );
  const offer = getNextOfferStep(trackedLance, validation.availableOptions);

  if (!offer) {
    return {
      customer,
      status: "skipped",
      reason: isAtLastOfferStep(trackedLance)
        ? "already_at_last_tier"
        : trackedLance && !isRecognizedOfferState(trackedLance)
          ? "unsupported_current_lance_type"
          : "next_offer_not_available",
      currentLance,
      validation,
    };
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
    reason: trackedLance ? "progression_upgrade" : "first_offer",
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
  reason: "first_offer" | "progression_upgrade";
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
  const explanation =
    group.reason === "progression_upgrade"
      ? "Ao confirmar, atualizaremos seu lance automático para esta nova condição."
      : "Ao confirmar, configuraremos o lance automático para esta condição.";

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

    const terminalContracts = initialCustomers
      .filter((customer) => {
        const contract = String(customer.nr_contrato || "").trim();
        const lanceRow = lanceByContract.get(contract);
        return isAtLastOfferStep(
          getTrackedLanceState(customer, lanceRow ?? null, reminderLogsByContract.get(contract) ?? []),
        );
      })
      .map((customer) => String(customer.nr_contrato || "").trim());
    const customers = initialCustomers.filter((customer) => {
      const contract = String(customer.nr_contrato || "").trim();
      return !terminalContracts.includes(contract);
    });
    logger.log("Offer reminder selection summary", {
      source: payloadCustomers ? "payload" : "database",
      fetchedCount: initialCustomers.length,
      filteredOutAlreadyAtLastTierCount: terminalContracts.length,
      selectedCount: customers.length,
      lanceRowCount: lanceRows.length,
      reminderLogCount: reminderLogs.length,
    });

    const client = new HttpClient(getConfig().servopa);
    const results: OfferReminderDecision[] = [];

    try {
      await client.login();

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
      candidatesByOffer: {
        fidelidade30: candidateResults.filter(
          (result) => result.status === "candidate" && result.offer.pctLance === 30,
        ).length,
        fidelidade15: candidateResults.filter(
          (result) => result.status === "candidate" && result.offer.pctLance === 15,
        ).length,
      },
      results: results.map(summarizeDecision),
    };
  },
});
