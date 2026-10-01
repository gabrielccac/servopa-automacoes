import { AbortTaskRunError, logger, task, wait } from "@trigger.dev/sdk";
import {
  registerCustomerBid,
  type CustomerBidRegisterResult,
} from "../lib/servopa/customer-bid-register.js";
import {
  simulateCustomerBid,
  type BidSimulationResult,
} from "../lib/servopa/customer-bid-simulation.js";
import { getConfig } from "../lib/config.js";
import {
  getCustomerLanceOptions,
  type CustomerLanceOptionsResult,
} from "../lib/servopa/customer-lances.js";
import type { ServopaCustomerRef } from "../lib/servopa/customer-context.js";
import { HttpClient } from "../lib/servopa/http-client.js";
import { buildDateScopedReminderIdempotencyKey } from "../lib/idempotency.js";
import { normalizePhone } from "../lib/parsers.js";
import { parseReminderPayload, type ReminderTaskInput } from "../lib/reminders/shared.js";
import {
  buildBidSubmissionIdempotencyKey,
  fetchSubmittedBidLogsForReferenceMonth,
  upsertBidLog,
} from "../lib/supabase/bid-logs.js";
import {
  BID_COMPROVANTE_REMINDER_TYPE,
  upsertReminderLog,
} from "../lib/supabase/reminder-logs.js";
import {
  fetchSubmitBidCandidates,
  type SubmitBidCandidate,
} from "../lib/supabase/submit-bid.js";
import { getTodayIsoDateInSaoPaulo } from "../lib/supabase/customers.js";
import {
  buildBidReceiptMessage,
} from "../lib/whatsapp/templates.js";
import {
  getSendResponseExternalId,
  getZApiConfig,
  sendButtonActionsMessage,
  sendTextMessage,
} from "../lib/whatsapp/zapi.js";

type SubmitBidTaskInput = ReminderTaskInput<SubmitBidCandidate>;

const SUBMIT_BID_CUSTOMER_KEYS = ["nr_contrato", "nr_cota", "nr_grupo", "tp_lance", "pct_lance"];

function getSubmitBidReviewConfig(): { managerPhone: string; webhookUrl: string } {
  const managerPhone = process.env.SUBMIT_BID_MANAGER_PHONE?.trim();
  const webhookUrl = process.env.SUBMIT_BID_REVIEW_WEBHOOK_URL?.trim();
  if (!managerPhone || !webhookUrl) {
    throw new Error(
      "SUBMIT_BID_MANAGER_PHONE and SUBMIT_BID_REVIEW_WEBHOOK_URL are required",
    );
  }
  return { managerPhone, webhookUrl };
}

function isApprovedConfirmation(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const approved = (payload as Record<string, unknown>).approved;
  return approved === true || approved === "true" || approved === 1 || approved === "1";
}

export function normalizeRequestedDtVenc(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 31) {
    return value;
  }

  if (typeof value === "string" && /^\d{1,2}$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return parsed >= 1 && parsed <= 31 ? parsed : null;
  }

  return null;
}

type SubmitBidCheckResult =
  | {
      customer: SubmitBidCandidate;
      status: "ready";
      requestedBid: {
        tp_lance: "FIXO" | "FIDELIDADE";
        pct_lance: number;
      };
      validation: CustomerLanceOptionsResult;
      matchedOption: {
        lance_type: "FIDELIDADE" | "FIXO" | "LIVRE";
        pct_lance: number | null;
        vl_lance: string | null;
        periodo_meses: number | null;
      };
    }
  | {
      customer: SubmitBidCandidate;
      status: "skipped";
      reason:
        | "missing_customer_context"
        | "inactive_customer"
        | "invalid_requested_bid"
        | "requested_option_not_available";
      requestedBid?: {
        tp_lance: string | null;
        pct_lance: number | null;
      };
      availableOptions?: Array<{
        lance_type: "FIDELIDADE" | "FIXO" | "LIVRE";
        pct_lance: number | null;
        vl_lance: string | null;
        periodo_meses: number | null;
      }>;
      validation?: CustomerLanceOptionsResult;
    }
  | {
      customer: SubmitBidCandidate;
      status: "failed";
      error: string;
    };

type SubmitBidSimulationResult =
  | {
      customer: SubmitBidCandidate;
      status: "simulated";
      simulation: BidSimulationResult;
    }
  | {
      customer: SubmitBidCandidate;
      status: "failed";
      error: string;
    };

type SubmitBidExecutionResult =
  | {
      customer: SubmitBidCandidate;
      status: "submitted";
      simulation: BidSimulationResult;
      register: CustomerBidRegisterResult;
      customerMessage: {
        messageBody: string;
        sendResponse: Awaited<ReturnType<typeof sendButtonActionsMessage>>;
      };
    }
  | {
      customer: SubmitBidCandidate;
      status: "failed";
      step: "register" | "customer-message";
      simulation?: BidSimulationResult;
      register?: CustomerBidRegisterResult;
      error: string;
    };

function toCustomerRef(customer: SubmitBidCandidate): ServopaCustomerRef {
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

function normalizeBidType(value: string | null | undefined): "FIXO" | "FIDELIDADE" | null {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "FIXO" || normalized === "FIDELIDADE") {
    return normalized;
  }

  return null;
}

function summarizeOptions(validation: CustomerLanceOptionsResult) {
  return validation.availableOptions.map((option) => ({
    lance_type: option.lance_type,
    pct_lance: option.pct_lance,
    vl_lance: option.vl_lance,
    periodo_meses: option.periodo_meses,
  }));
}

function findMatchingOption(
  validation: CustomerLanceOptionsResult,
  requestedBidType: "FIXO" | "FIDELIDADE",
  requestedPercent: number,
) {
  if (requestedBidType === "FIDELIDADE") {
    return (
      validation.availableOptions.find(
        (option) =>
          option.lance_type === "FIDELIDADE" && option.pct_lance === requestedPercent,
      ) ?? null
    );
  }

  return (
    validation.availableOptions.find(
      (option) => option.lance_type === "FIXO" && option.pct_lance === requestedPercent,
    ) ?? null
  );
}

function evaluateCustomer(
  customer: SubmitBidCandidate,
  validation: CustomerLanceOptionsResult,
): SubmitBidCheckResult {
  if (customer.dt_cancelamento !== null) {
    return {
      customer,
      status: "skipped",
      reason: "inactive_customer",
      requestedBid: {
        tp_lance: customer.tp_lance,
        pct_lance: customer.pct_lance,
      },
      validation,
      availableOptions: summarizeOptions(validation),
    };
  }

  const requestedBidType = normalizeBidType(customer.tp_lance);
  const requestedPercent = customer.pct_lance;

  if (!requestedBidType || requestedPercent === null) {
    return {
      customer,
      status: "skipped",
      reason: "invalid_requested_bid",
      requestedBid: {
        tp_lance: customer.tp_lance,
        pct_lance: customer.pct_lance,
      },
      validation,
      availableOptions: summarizeOptions(validation),
    };
  }

  const matchedOption = findMatchingOption(validation, requestedBidType, requestedPercent);

  if (!matchedOption) {
    return {
      customer,
      status: "skipped",
      reason: "requested_option_not_available",
      requestedBid: {
        tp_lance: requestedBidType,
        pct_lance: requestedPercent,
      },
      validation,
      availableOptions: summarizeOptions(validation),
    };
  }

  return {
    customer,
    status: "ready",
    requestedBid: {
      tp_lance: requestedBidType,
      pct_lance: requestedPercent,
    },
    validation,
    matchedOption: {
      lance_type: matchedOption.lance_type,
      pct_lance: matchedOption.pct_lance,
      vl_lance: matchedOption.vl_lance,
      periodo_meses: matchedOption.periodo_meses,
    },
  };
}

function summarizeResult(result: SubmitBidCheckResult) {
  if (result.status === "failed") {
    return {
      customer: result.customer,
      status: result.status,
      error: result.error,
    };
  }

  if (result.status === "skipped") {
    return {
      customer: result.customer,
      status: result.status,
      reason: result.reason,
      requestedBid: result.requestedBid ?? null,
      availableOptions: result.availableOptions ?? [],
    };
  }

  return {
    customer: result.customer,
    status: result.status,
    requestedBid: result.requestedBid,
    matchedOption: result.matchedOption,
    availableOptions: summarizeOptions(result.validation),
  };
}

function summarizeSimulationResult(result: SubmitBidSimulationResult) {
  if (result.status === "failed") {
    return {
      customer: result.customer,
      status: result.status,
      error: result.error,
    };
  }

  return {
    customer: result.customer,
    status: result.status,
    rawContrato: result.simulation.rawContrato,
    customerContextConfirmed: result.simulation.customerContextConfirmed,
    currentInfo: result.simulation.currentInfo,
    eventInfo: result.simulation.eventInfo,
    simulationRequestPayload: result.simulation.simulationRequestPayload,
    registerPayload: result.simulation.registerPayload,
  };
}

function summarizeExecutionResult(result: SubmitBidExecutionResult) {
  if (result.status === "failed") {
    return {
      customer: result.customer,
      status: result.status,
      step: result.step,
      error: result.error,
      registerResponse: result.register?.registerResponse ?? null,
      comprovanteUrl: result.register?.comprovanteUrl ?? null,
    };
  }

  return {
    customer: result.customer,
    status: result.status,
    registerResponse: result.register.registerResponse,
    comprovantePayload: result.register.comprovantePayload,
    comprovanteUrl: result.register.comprovanteUrl,
    customerMessage: {
      messageBody: result.customerMessage.messageBody,
      sendResponse: result.customerMessage.sendResponse,
    },
  };
}

function getReferenceMonth(date = new Date()): string {
  return `${getTodayIsoDateInSaoPaulo(date).slice(0, 7)}-01`;
}

function formatRequestedBid(requestedBid: {
  tp_lance: string | null;
  pct_lance: number | null;
}): string {
  const type = String(requestedBid.tp_lance || "---").trim() || "---";
  const percent =
    requestedBid.pct_lance === null || requestedBid.pct_lance === undefined
      ? "---"
      : String(requestedBid.pct_lance);

  return `${type} ${percent}%`;
}

function formatAvailableOptions(
  options: Array<{
    lance_type: "FIDELIDADE" | "FIXO" | "LIVRE";
    pct_lance: number | null;
    vl_lance: string | null;
    periodo_meses: number | null;
  }>,
): string {
  if (options.length === 0) {
    return "nenhuma";
  }

  return options
    .map((option) => {
      const percent =
        option.pct_lance === null || option.pct_lance === undefined
          ? "---"
          : `${option.pct_lance}%`;
      const periodo =
        option.periodo_meses === null || option.periodo_meses === undefined
          ? ""
          : `/${option.periodo_meses}m`;
      return `${option.lance_type} ${percent}${periodo}`;
    })
    .join(", ");
}

function buildManagerReviewMessage(results: SubmitBidCheckResult[]): string {
  const readyResults = results.filter((result) => result.status === "ready");
  const unavailableResults = results.filter(
    (result) =>
      result.status === "skipped" && result.reason === "requested_option_not_available",
  );
  const otherSkippedResults = results.filter(
    (result) =>
      result.status === "skipped" && result.reason !== "requested_option_not_available",
  );
  const failedResults = results.filter((result) => result.status === "failed");

  const lines = [
    "Revisão da lista de lances para submissão:",
    "",
    `Totais: ${readyResults.length} prontos, ${unavailableResults.length} com revisão na base, ${otherSkippedResults.length} outros pulados, ${failedResults.length} com erro.`,
    "",
    "Clientes:",
  ];

  for (const result of results) {
    const contract = String(result.customer.nr_contrato || "---").trim() || "---";
    const name = String(result.customer.nm_consorciado || "Cliente").trim() || "Cliente";

    if (result.status === "ready") {
      lines.push(
        `✅ ${contract} - ${name} | solicitar ${formatRequestedBid(result.requestedBid)} | disponível`,
      );
      continue;
    }

    if (result.status === "failed") {
      lines.push(`⚠️ ${contract} - ${name} | erro: ${result.error}`);
      continue;
    }

    const requestedBid = result.requestedBid
      ? formatRequestedBid(result.requestedBid)
      : "---";
    const availableOptions = formatAvailableOptions(result.availableOptions ?? []);

    if (result.reason === "requested_option_not_available") {
      lines.push(
        `❌ ${contract} - ${name} | solicitar ${requestedBid} | precisa revisão na base | disponíveis: ${availableOptions}`,
      );
      continue;
    }

    lines.push(
      `⚠️ ${contract} - ${name} | ${result.reason} | solicitar ${requestedBid} | disponíveis: ${availableOptions}`,
    );
  }

  lines.push("");
  lines.push("Se estiver tudo certo, confirme no botão abaixo para continuar o workflow.");

  return lines.join("\n");
}

export const submitBid = task({
  id: "submit-bid",
  maxDuration: 900,
  queue: { concurrencyLimit: 1 },
  run: async (payload?: SubmitBidTaskInput) => {
    const { customers: payloadCustomers, dryRun, asOfDate } = parseReminderPayload(
      payload,
      SUBMIT_BID_CUSTOMER_KEYS,
    );
    const payloadRecord =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    const stopBeforeRegister = payloadRecord?.stopBeforeRegister === true;
    const requestedDtVenc = normalizeRequestedDtVenc(payloadRecord?.dtVenc);
    const hasRequestedDtVenc = Boolean(
      payloadRecord && Object.prototype.hasOwnProperty.call(payloadRecord, "dtVenc"),
    );
    if (hasRequestedDtVenc && requestedDtVenc === null) {
      throw new Error("dtVenc must be a valid day of month between 1 and 31");
    }
    const requestedContracts = [
      ...new Set(
        (payloadCustomers ?? [])
          .map((customer) => String(customer.nr_contrato || "").trim())
          .filter(Boolean),
      ),
    ];
    const initialCustomers =
      payloadCustomers ??
      (await fetchSubmitBidCandidates(
        requestedContracts.length > 0 || requestedDtVenc !== null
          ? {
              contracts: requestedContracts.length > 0 ? requestedContracts : undefined,
              dtVenc: requestedDtVenc,
            }
          : undefined,
      ));
    const referenceMonth = getReferenceMonth(
      asOfDate ? new Date(`${asOfDate}T12:00:00.000Z`) : undefined,
    );
    const submittedBidLogs = await fetchSubmittedBidLogsForReferenceMonth(referenceMonth);
    const submittedContracts = new Set(submittedBidLogs.map((row) => row.nr_contrato));
    const dedupedCustomers = initialCustomers.filter((customer) => {
      const contract = String(customer.nr_contrato || "").trim();
      return !submittedContracts.has(contract);
    });
    const alreadySubmittedCount = initialCustomers.length - dedupedCustomers.length;

    const missingContextCustomers = dedupedCustomers.filter(
      (customer) =>
        !String(customer.nr_contrato || "").trim() ||
        !String(customer.nr_cota || "").trim() ||
        !String(customer.nr_grupo || "").trim(),
    );
    const customers = dedupedCustomers.filter(
      (customer) =>
        String(customer.nr_contrato || "").trim() &&
        String(customer.nr_cota || "").trim() &&
        String(customer.nr_grupo || "").trim(),
    );

    logger.log("Submit bid precheck selection summary", {
      source: payloadCustomers ? "payload" : "database",
      requestedDtVenc,
      fetchedCount: initialCustomers.length,
      alreadySubmittedCount,
      missingContextCount: missingContextCustomers.length,
      selectedCount: customers.length,
    });

    const results: SubmitBidCheckResult[] = missingContextCustomers.map((customer) => ({
      customer,
      status: "skipped",
      reason: "missing_customer_context",
      requestedBid: {
        tp_lance: customer.tp_lance,
        pct_lance: customer.pct_lance,
      },
    }));

    const client = new HttpClient(getConfig().servopa);

    try {
      await client.login();

      for (const customer of customers) {
        try {
          const validation = await getCustomerLanceOptions(client, toCustomerRef(customer));
          results.push(evaluateCustomer(customer, validation));
        } catch (error) {
          results.push({
            customer,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      await client.logout().catch(() => undefined);
      await client.close();
    }

    const readyResults = results.filter((result) => result.status === "ready");
    const skippedResults = results.filter((result) => result.status === "skipped");
    const failedResults = results.filter((result) => result.status === "failed");

    if (dryRun) {
      return {
        workflow: "submit-bid",
        mode: "dry-run-precheck-only",
        dryRun: true,
        source: payloadCustomers ? "payload" : "database",
        requestedDtVenc,
        fetchedCount: initialCustomers.length,
        alreadySubmittedCount,
        missingContextCount: missingContextCustomers.length,
        selectedCount: customers.length,
        readyCount: readyResults.length,
        skippedCount: skippedResults.length,
        errorCount: failedResults.length,
        sideEffects: {
          managerMessages: 0,
          customerMessages: 0,
          bidRegistrations: 0,
          databaseWrites: 0,
          callbackTokens: 0,
        },
        results: results.map(summarizeResult),
      };
    }

    const { managerPhone, webhookUrl } = getSubmitBidReviewConfig();
    const token = await wait.createToken({
      timeout: "24h",
      tags: ["submit-bid-review"],
    });
    const managerConfirmationUrl = `${webhookUrl}?callback=${encodeURIComponent(
      token.url,
    )}&approved=true`;
    const zapiConfig = getZApiConfig();
    const reviewMessage = buildManagerReviewMessage(results);

    const reviewSendResponse = await sendButtonActionsMessage(zapiConfig, {
      phone: managerPhone,
      message: reviewMessage,
      buttonActions: [
        {
          id: "confirm-submit-bid-list",
          type: "URL",
          url: managerConfirmationUrl,
          label: "Confirmar lista",
        },
      ],
    });

    logger.log("Waiting for submit bid manager confirmation", {
      phone: managerPhone,
      waitpointTokenId: token.id,
      reviewMessageLength: reviewMessage.length,
    });

    const confirmationPayload = await wait
      .forToken<Record<string, unknown>>(token)
      .unwrap();

    if (!isApprovedConfirmation(confirmationPayload)) {
      throw new AbortTaskRunError("Submit bid manager confirmation was not approved");
    }

    const confirmationSendResponse = await sendTextMessage(zapiConfig, {
      phone: managerPhone,
      message: "Lista de lances confirmada para submeter.",
    });
    const simulationResults: SubmitBidSimulationResult[] = [];
    const executionResults: SubmitBidExecutionResult[] = [];

    try {
      await client.login();

      for (const readyResult of readyResults) {
        const customer = readyResult.customer;
        const contract = String(customer.nr_contrato || "").trim();
        const reminderReferenceDate = asOfDate ?? getTodayIsoDateInSaoPaulo();
        let simulation: BidSimulationResult | null = null;
        let register: CustomerBidRegisterResult | null = null;

        try {
          simulation = await simulateCustomerBid(
            client,
            toCustomerRef(customer),
            {
              tp_lance: readyResult.requestedBid.tp_lance,
              pct_lance: readyResult.requestedBid.pct_lance,
              diluicao_em_parcelas: customer.diluicao_em_parcelas ?? null,
            },
          );

          simulationResults.push({
            customer,
            status: "simulated",
            simulation,
          });

          if (stopBeforeRegister) {
            continue;
          }

          register = await registerCustomerBid(
            client,
            simulation.registerPayload,
            {
              currentInfo: simulation.currentInfo,
              eventInfo: simulation.eventInfo,
            },
          );

          logger.log("Submit bid register success", {
            contract,
            customerName: customer.nm_consorciado,
            registerResponse: register.registerResponse,
            comprovantePayload: register.comprovantePayload,
            comprovanteUrl: register.comprovanteUrl,
          });

          await upsertBidLog({
            nr_contrato: contract,
            nm_consorciado: customer.nm_consorciado,
            nr_cota: customer.nr_cota,
            nr_grupo: customer.nr_grupo ? String(customer.nr_grupo) : null,
            tp_lance: customer.tp_lance,
            pct_lance: customer.pct_lance,
            reference_month: referenceMonth,
            idempotency_key: buildBidSubmissionIdempotencyKey(contract, referenceMonth),
            status: "submitted",
            protocolo: register.registerResponse.protocolo,
            url_comprovante: register.comprovanteUrl,
            last_error: null,
          });

          const messageBody = buildBidReceiptMessage(
            customer.nm_consorciado,
            customer.nr_contrato,
            customer.nr_cota,
          );
          const phone = normalizePhone(customer.cd_whatsapp);
          if (!phone) {
            throw new Error("Customer does not have a valid WhatsApp number");
          }

          const sendResponse = await sendButtonActionsMessage(zapiConfig, {
            phone,
            message: messageBody,
            buttonActions: [
              {
                id: "1",
                type: "URL",
                label: "Acessar comprovante",
                url: register.comprovanteUrl,
              },
            ],
          });

          await upsertReminderLog({
            idempotency_key: buildDateScopedReminderIdempotencyKey(
              BID_COMPROVANTE_REMINDER_TYPE,
              contract,
              reminderReferenceDate,
            ),
            nr_contrato: contract,
            nm_consorciado: customer.nm_consorciado,
            cd_whatsapp: customer.cd_whatsapp,
            reminder_type: BID_COMPROVANTE_REMINDER_TYPE,
            reference_date: reminderReferenceDate,
            status: "sent",
            message_body: messageBody,
            external_message_id: getSendResponseExternalId(sendResponse),
            last_error: null,
            sent_at: new Date().toISOString(),
          });

          executionResults.push({
            customer,
            status: "submitted",
            simulation,
            register,
            customerMessage: {
              messageBody,
              sendResponse,
            },
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          logger.log("Submit bid execution failed", {
            contract,
            customerName: customer.nm_consorciado,
            error: errorMessage,
            simulationRequestPayload: simulation?.simulationRequestPayload ?? null,
            registerPayload: simulation?.registerPayload ?? null,
            registerResponse: register?.registerResponse ?? null,
            comprovantePayload: register?.comprovantePayload ?? null,
            comprovanteUrl: register?.comprovanteUrl ?? null,
          });

          if (!simulation) {
            simulationResults.push({
              customer,
              status: "failed",
              error: errorMessage,
            });
          } else if (!stopBeforeRegister) {
            const isRegisterFailure = register === null;

            await upsertBidLog({
              nr_contrato: contract,
              nm_consorciado: customer.nm_consorciado,
              nr_cota: customer.nr_cota,
              nr_grupo: customer.nr_grupo ? String(customer.nr_grupo) : null,
              tp_lance: customer.tp_lance,
              pct_lance: customer.pct_lance,
              reference_month: referenceMonth,
              idempotency_key: buildBidSubmissionIdempotencyKey(contract, referenceMonth),
              status: isRegisterFailure ? "failed" : "submitted",
              protocolo: register?.registerResponse.protocolo ?? null,
              url_comprovante: register?.comprovanteUrl ?? null,
              last_error: errorMessage,
            });

            if (!isRegisterFailure) {
              await upsertReminderLog({
                idempotency_key: buildDateScopedReminderIdempotencyKey(
                  BID_COMPROVANTE_REMINDER_TYPE,
                  contract,
                  reminderReferenceDate,
                ),
                nr_contrato: contract,
                nm_consorciado: customer.nm_consorciado,
                cd_whatsapp: customer.cd_whatsapp,
                reminder_type: BID_COMPROVANTE_REMINDER_TYPE,
                reference_date: reminderReferenceDate,
                status: "failed",
                message_body: buildBidReceiptMessage(
                  customer.nm_consorciado,
                  customer.nr_contrato,
                  customer.nr_cota,
                ),
                external_message_id: null,
                last_error: errorMessage,
                sent_at: null,
              });
            }

            executionResults.push({
              customer,
              status: "failed",
              step: isRegisterFailure ? "register" : "customer-message",
              simulation,
              register: register ?? undefined,
              error: errorMessage,
            });
          }

          if (simulation) {
            continue;
          }

          executionResults.push({
            customer,
            status: "failed",
            step: "register",
            simulation: undefined,
            error: errorMessage,
          });
        }
      }
    } finally {
      await client.logout().catch(() => undefined);
      await client.close();
    }

    const simulatedResults = simulationResults.filter(
      (result) => result.status === "simulated",
    );
    const simulationFailedResults = simulationResults.filter(
      (result) => result.status === "failed",
    );

    if (stopBeforeRegister) {
      return {
        workflow: "submit-bid",
        mode: "availability-check-manager-confirmation-and-simulation-only",
        stopBeforeRegister: true,
        source: payloadCustomers ? "payload" : "database",
        requestedDtVenc,
        fetchedCount: initialCustomers.length,
        alreadySubmittedCount,
        missingContextCount: missingContextCustomers.length,
        selectedCount: customers.length,
        readyCount: readyResults.length,
        skippedCount: skippedResults.length,
        errorCount: failedResults.length,
        managerPhone,
        waitpointTokenId: token.id,
        reviewSendResponse,
        confirmationPayload,
        confirmationSendResponse,
        simulatedCount: simulatedResults.length,
        simulationErrorCount: simulationFailedResults.length,
        results: results.map(summarizeResult),
        simulationResults: simulationResults.map(summarizeSimulationResult),
      };
    }

    const submittedResults = executionResults.filter((result) => result.status === "submitted");
    const executionFailedResults = executionResults.filter((result) => result.status === "failed");

    return {
      workflow: "submit-bid",
      mode: "availability-check-manager-confirmation-simulation-and-register",
      stopBeforeRegister: false,
      source: payloadCustomers ? "payload" : "database",
      requestedDtVenc,
      fetchedCount: initialCustomers.length,
      alreadySubmittedCount,
      missingContextCount: missingContextCustomers.length,
      selectedCount: customers.length,
      readyCount: readyResults.length,
      skippedCount: skippedResults.length,
      errorCount: failedResults.length,
      managerPhone,
      waitpointTokenId: token.id,
      reviewSendResponse,
      confirmationPayload,
      confirmationSendResponse,
      simulatedCount: simulatedResults.length,
      simulationErrorCount: simulationFailedResults.length,
      submittedCount: submittedResults.length,
      registerErrorCount: executionFailedResults.length,
      results: results.map(summarizeResult),
      simulationResults: simulationResults.map(summarizeSimulationResult),
      executionResults: executionResults.map(summarizeExecutionResult),
    };
  },
});
