import { logger, task } from "@trigger.dev/sdk";
import { getConfig } from "../lib/config.js";
import {
  getCustomerPaymentInfo,
  type CustomerPaymentInfoResult,
  type CustomerPaymentInstallment,
} from "../lib/servopa/customer-payment-info.js";
import type { ServopaCustomerRef } from "../lib/servopa/customer-context.js";
import { HttpClient } from "../lib/servopa/http-client.js";
import { buildDateScopedReminderIdempotencyKey } from "../lib/idempotency.js";
import { normalizePhone } from "../lib/parsers.js";
import {
  logReminderProgress,
  parseReminderPayload,
  sendReminderMessage,
  sleep,
  type ReminderTaskInput,
} from "../lib/reminders/shared.js";
import {
  fetchReminderLogs,
  isTerminalReminderLogStatus,
  OVERDUE_PAYMENT_D1_REMINDER_TYPE,
  OVERDUE_PAYMENT_D7_REMINDER_TYPE,
  OVERDUE_PAYMENT_D14_REMINDER_TYPE,
  upsertReminderLog,
} from "../lib/supabase/reminder-logs.js";
import {
  fetchOverduePaymentRecords,
  getTodayIsoDateInSaoPaulo,
  type OverduePaymentRecord,
} from "../lib/supabase/customers.js";
import {
  buildOverduePaymentD1Message,
  buildOverduePaymentD7Message,
  buildOverduePaymentD15Message,
} from "../lib/whatsapp/templates.js";
import {
  getSendResponseExternalId,
  getZApiConfig,
  sendExecutionSummary,
  type ZApiButtonAction,
  type ZApiSendTextResponse,
} from "../lib/whatsapp/zapi.js";

type OverdueReminderTaskInput = ReminderTaskInput<OverduePaymentRecord>;

function getDryRunReferenceDate(payload: unknown): string {
  if (
    payload &&
    typeof payload === "object" &&
    "dryRun" in payload &&
    (payload as { dryRun?: unknown }).dryRun === true
  ) {
    const referenceDate = (payload as { referenceDate?: unknown }).referenceDate;
    if (typeof referenceDate === "string" && parseIsoDateOnly(referenceDate)) {
      return referenceDate;
    }
  }

  return getTodayIsoDateInSaoPaulo();
}

const OVERDUE_CUSTOMER_KEYS = ["nr_contrato", "nr_cota", "dt_primeira_ocorrencia"];

interface OverdueReminderStage {
  reminderType: string;
  label: "day_1" | "day_7" | "day_14" | "day_14_repeat";
  overdueDay: number;
}

interface OverdueSelectionTarget {
  selectedBoleto: CustomerPaymentInstallment;
  selectedStrategy: "single" | "diluicao" | "latest";
  hasMultiplePendencies: boolean;
}

type OverduePaymentReminderResult =
  | {
      customer: OverduePaymentRecord;
      status: "sent" | "dry-run";
      stage: OverdueReminderStage;
      selectedTarget: OverdueSelectionTarget;
      paymentInfo: CustomerPaymentInfoResult;
      reminderMessage: string;
      sendMode: "button-actions" | "text" | "dry-run";
      sendResponse: ZApiSendTextResponse | null;
    }
  | {
      customer: OverduePaymentRecord;
      status: "skipped";
      stage: OverdueReminderStage;
      reason: string;
      paymentInfo: CustomerPaymentInfoResult;
    }
  | {
      customer: OverduePaymentRecord;
      status: "failed";
      stage: OverdueReminderStage;
      error: string;
    };

type OverdueSuccessfulReminderResult = Extract<
  OverduePaymentReminderResult,
  { status: "sent" | "dry-run" }
>;

function isOverdueSentResult(
  result: OverduePaymentReminderResult,
): result is OverdueSuccessfulReminderResult & { status: "sent" } {
  return result.status === "sent";
}

function isOverdueDryRunResult(
  result: OverduePaymentReminderResult,
): result is OverdueSuccessfulReminderResult & { status: "dry-run" } {
  return result.status === "dry-run";
}

function parseIsoDateOnly(value: string | null): Date | null {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  return new Date(
    Date.UTC(
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10) - 1,
      Number.parseInt(match[3], 10),
    ),
  );
}

function diffDays(startIsoDate: string | null, endIsoDate: string): number | null {
  const startDate = parseIsoDateOnly(startIsoDate);
  const endDate = parseIsoDateOnly(endIsoDate);
  if (!startDate || !endDate) return null;

  const diffMs = endDate.getTime() - startDate.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  return diffDays;
}

export function resolveReminderStage(
  record: OverduePaymentRecord,
  todayIso: string,
): OverdueReminderStage | null {
  const overdueDay = diffDays(record.dt_primeira_ocorrencia, todayIso);
  if (overdueDay === null || overdueDay <= 0) {
    return null;
  }

  if (overdueDay === 1) {
    return {
      reminderType: OVERDUE_PAYMENT_D1_REMINDER_TYPE,
      label: "day_1",
      overdueDay,
    };
  }

  if (overdueDay === 7) {
    return {
      reminderType: OVERDUE_PAYMENT_D7_REMINDER_TYPE,
      label: "day_7",
      overdueDay,
    };
  }

  if (overdueDay === 14) {
    return {
      reminderType: OVERDUE_PAYMENT_D14_REMINDER_TYPE,
      label: "day_14",
      overdueDay,
    };
  }

  if (overdueDay > 14 && (overdueDay - 14) % 14 === 0) {
    return {
      reminderType: OVERDUE_PAYMENT_D14_REMINDER_TYPE,
      label: "day_14_repeat",
      overdueDay,
    };
  }

  return null;
}

function getReminderLogReference(
  customer: OverduePaymentRecord,
  stage: OverdueReminderStage,
): string {
  const firstOccurrence = String(customer.dt_primeira_ocorrencia || "").trim();
  return stage.label === "day_14_repeat"
    ? `${firstOccurrence}:day-${stage.overdueDay}`
    : firstOccurrence;
}

function parseCustomerRef(record: OverduePaymentRecord): ServopaCustomerRef {
  const contract = String(record.nr_contrato || "").trim();
  const cota = String(record.nr_cota || "").trim();
  const cotaMatch = cota.match(/^(\d+)\.(\d+)-(\d+)$/);

  if (!contract) {
    throw new Error("Missing nr_contrato in overdue record");
  }

  if (!cotaMatch) {
    throw new Error(`Could not parse nr_cota from overdue record: ${cota}`);
  }

  return {
    grupo: cotaMatch[1],
    plano: cotaMatch[2],
    digito: cotaMatch[3],
    nr_contrato: contract,
  };
}

function isDiluicaoBoleto(boleto: CustomerPaymentInstallment): boolean {
  return String(boleto.ds_tipo || "").toLowerCase().includes("dilu");
}

function selectLatestBoleto(boletos: CustomerPaymentInstallment[]): CustomerPaymentInstallment {
  return [...boletos].sort((left, right) => {
    const leftParcela = left.nr_parcela ?? -1;
    const rightParcela = right.nr_parcela ?? -1;

    if (rightParcela !== leftParcela) {
      return rightParcela - leftParcela;
    }

    return (right.vl_atual ?? right.vl_emitido ?? 0) - (left.vl_atual ?? left.vl_emitido ?? 0);
  })[0];
}

function selectOverduePaymentTarget(
  boletos: CustomerPaymentInstallment[],
): OverdueSelectionTarget {
  if (boletos.length === 1) {
    return {
      selectedBoleto: boletos[0],
      selectedStrategy: "single",
      hasMultiplePendencies: false,
    };
  }

  const diluicaoBoleto = boletos.find(isDiluicaoBoleto);
  if (diluicaoBoleto) {
    return {
      selectedBoleto: diluicaoBoleto,
      selectedStrategy: "diluicao",
      hasMultiplePendencies: true,
    };
  }

  return {
    selectedBoleto: selectLatestBoleto(boletos),
    selectedStrategy: "latest",
    hasMultiplePendencies: true,
  };
}

function buildOverdueReminderMessage(
  stage: OverdueReminderStage,
  customer: OverduePaymentRecord,
  hasMultiplePendencies: boolean,
): string {
  if (stage.label === "day_1") {
    return buildOverduePaymentD1Message(
      customer.nm_consorciado,
      customer.nr_contrato,
      customer.nr_cota,
      hasMultiplePendencies,
    );
  }

  if (stage.label === "day_7") {
    return buildOverduePaymentD7Message(
      customer.nm_consorciado,
      customer.nr_contrato,
      customer.nr_cota,
      hasMultiplePendencies,
    );
  }

  return buildOverduePaymentD15Message(
    customer.nm_consorciado,
    customer.nr_contrato,
    customer.nr_cota,
    hasMultiplePendencies,
  );
}

function buildButtonActions(boleto: CustomerPaymentInstallment): ZApiButtonAction[] {
  const buttonActions: ZApiButtonAction[] = [];

  if (boleto.boleto_url) {
    buttonActions.push({
      id: "1",
      type: "URL",
      url: boleto.boleto_url,
      label: "Boleto",
    });
  }

  if (boleto.pix_url) {
    buttonActions.push({
      id: buttonActions.length === 0 ? "1" : "2",
      type: "URL",
      url: boleto.pix_url,
      label: "Pix",
    });
  }

  return buttonActions;
}

function summarizeResult(result: OverduePaymentReminderResult) {
  if (result.status === "failed") {
    return {
      customer: result.customer,
      status: result.status,
      stage: result.stage,
      error: result.error,
    };
  }

  if (result.status === "skipped") {
    return {
      customer: result.customer,
      status: result.status,
      stage: result.stage,
      reason: result.reason,
      customerContextConfirmed: result.paymentInfo.customerContextConfirmed,
      boletoCount: result.paymentInfo.boletos.length,
      parcelaCount: result.paymentInfo.parcelas.length,
    };
  }

  return {
    customer: result.customer,
    status: result.status,
    stage: result.stage,
    customerContextConfirmed: result.paymentInfo.customerContextConfirmed,
    boletoCount: result.paymentInfo.boletos.length,
    parcelaCount: result.paymentInfo.parcelas.length,
    selectedStrategy: result.selectedTarget.selectedStrategy,
    selectedBoleto: {
      nr_parcela: result.selectedTarget.selectedBoleto.nr_parcela,
      ds_tipo: result.selectedTarget.selectedBoleto.ds_tipo,
      boleto_url: result.selectedTarget.selectedBoleto.boleto_url,
      pix_url: result.selectedTarget.selectedBoleto.pix_url,
    },
    reminderMessage: result.reminderMessage,
    sendMode: result.sendMode,
    sendResponse: result.sendResponse,
  };
}

export const overduePaymentReminder = task({
  id: "overdue-payment-reminder",
  maxDuration: 900,
  queue: { concurrencyLimit: 1 },
  run: async (payload: unknown) => {
    const { customers: payloadCustomers, dryRun, respectIdempotency, asOfDate, sendSummary } =
      parseReminderPayload(payload as OverdueReminderTaskInput, OVERDUE_CUSTOMER_KEYS);
    const fetchedRecords = payloadCustomers ?? (await fetchOverduePaymentRecords());
    const todayIso = asOfDate ?? getDryRunReferenceDate(payload);
    const stageEligibleRecords = fetchedRecords
      .map((customer) => ({
        customer,
        stage: resolveReminderStage(customer, todayIso),
      }))
      .filter(
        (
          entry,
        ): entry is { customer: OverduePaymentRecord; stage: OverdueReminderStage } =>
          entry.stage !== null,
      );
    const shouldApplyReminderLogFilter = !payloadCustomers || respectIdempotency;
    const shouldPersistReminderLogs = !dryRun;
    const zapiConfig = getZApiConfig();
    const existingLogs =
      shouldApplyReminderLogFilter || shouldPersistReminderLogs
        ? await fetchReminderLogs({
            idempotencyKeys: stageEligibleRecords.map(({ customer, stage }) =>
              buildDateScopedReminderIdempotencyKey(
                stage.reminderType,
                customer.nr_contrato,
                getReminderLogReference(customer, stage),
              ),
            ),
          })
        : [];
    const existingLogsByKey = new Map(existingLogs.map((log) => [log.idempotency_key, log]));
    const selectedRecords = shouldApplyReminderLogFilter
      ? stageEligibleRecords.filter(({ customer, stage }) => {
          const idempotencyKey = buildDateScopedReminderIdempotencyKey(
            stage.reminderType,
            customer.nr_contrato,
            getReminderLogReference(customer, stage),
          );
          return !isTerminalReminderLogStatus(existingLogsByKey.get(idempotencyKey)?.status);
        })
      : stageEligibleRecords;

    logger.log("Overdue payment reminder selection summary", {
      source: payloadCustomers ? "payload" : "database",
      dryRun,
      respectIdempotency,
      fetchedCount: fetchedRecords.length,
      activeCount: fetchedRecords.length,
      stageEligibleCount: stageEligibleRecords.length,
      selectedCount: selectedRecords.length,
      existingReminderLogCount: existingLogs.length,
      referenceDate: todayIso,
    });

    const client = new HttpClient(getConfig().servopa);
    const results: OverduePaymentReminderResult[] = [];

    try {
      if (selectedRecords.length > 0) {
        await client.login();
      }

      for (const [index, entry] of selectedRecords.entries()) {
        const idempotencyKey = buildDateScopedReminderIdempotencyKey(
          entry.stage.reminderType,
          entry.customer.nr_contrato,
          getReminderLogReference(entry.customer, entry.stage),
        );
        let reminderMessage: string | null = null;

        try {
          const customerRef = parseCustomerRef(entry.customer);
          const paymentInfo = await getCustomerPaymentInfo(client, customerRef);

          if (paymentInfo.paymentStatus !== "eligible" || paymentInfo.boletos.length === 0) {
            results.push({
              customer: entry.customer,
              status: "skipped",
              stage: entry.stage,
              reason:
                paymentInfo.message ?? "Payment information is not available right now",
              paymentInfo,
            });

            if (shouldPersistReminderLogs) {
              await upsertReminderLog({
                idempotency_key: idempotencyKey,
                nr_contrato: String(entry.customer.nr_contrato || "").trim(),
                nm_consorciado: entry.customer.nm_consorciado,
                cd_whatsapp: entry.customer.cd_whatsapp,
                reminder_type: entry.stage.reminderType,
                reference_date: getReminderLogReference(entry.customer, entry.stage),
                status: "skipped",
                message_body: null,
                last_error: null,
                sent_at: null,
              });
            }
          } else {
            const phone = normalizePhone(entry.customer.cd_whatsapp);
            reminderMessage = buildOverdueReminderMessage(
              entry.stage,
              entry.customer,
              paymentInfo.boletos.length > 1,
            );

            if (!phone) {
              results.push({
                customer: entry.customer,
                status: "skipped",
                stage: entry.stage,
                reason: "Customer does not have a valid WhatsApp number",
                paymentInfo,
              });

              if (shouldPersistReminderLogs) {
                await upsertReminderLog({
                  idempotency_key: idempotencyKey,
                  nr_contrato: String(entry.customer.nr_contrato || "").trim(),
                  nm_consorciado: entry.customer.nm_consorciado,
                  cd_whatsapp: entry.customer.cd_whatsapp,
                  reminder_type: entry.stage.reminderType,
                  reference_date: getReminderLogReference(entry.customer, entry.stage),
                  status: "skipped",
                  message_body: reminderMessage,
                  last_error: null,
                  sent_at: null,
                });
              }
            } else {
              const selectedTarget = selectOverduePaymentTarget(paymentInfo.boletos);
              reminderMessage = buildOverdueReminderMessage(
                entry.stage,
                entry.customer,
                selectedTarget.hasMultiplePendencies,
              );
              const buttonActions = buildButtonActions(selectedTarget.selectedBoleto);
              const { sendMode, sendResponse } = await sendReminderMessage(zapiConfig, {
                phone,
                message: reminderMessage,
                buttonActions,
                dryRun,
              });
              const status = dryRun ? "dry-run" : "sent";

              results.push({
                customer: entry.customer,
                status,
                stage: entry.stage,
                selectedTarget,
                paymentInfo,
                reminderMessage,
                sendMode,
                sendResponse,
              });

              if (shouldPersistReminderLogs) {
                await upsertReminderLog({
                  idempotency_key: idempotencyKey,
                  nr_contrato: String(entry.customer.nr_contrato || "").trim(),
                  nm_consorciado: entry.customer.nm_consorciado,
                  cd_whatsapp: entry.customer.cd_whatsapp,
                  reminder_type: entry.stage.reminderType,
                  reference_date: getReminderLogReference(entry.customer, entry.stage),
                  status: "sent",
                  message_body: reminderMessage,
                  external_message_id: getSendResponseExternalId(sendResponse),
                  last_error: null,
                  sent_at: new Date().toISOString(),
                });
              }
            }
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          results.push({
            customer: entry.customer,
            status: "failed",
            stage: entry.stage,
            error: errorMessage,
          });

          if (shouldPersistReminderLogs) {
            await upsertReminderLog({
              idempotency_key: idempotencyKey,
              nr_contrato: String(entry.customer.nr_contrato || "").trim(),
              nm_consorciado: entry.customer.nm_consorciado,
              cd_whatsapp: entry.customer.cd_whatsapp,
              reminder_type: entry.stage.reminderType,
              reference_date: getReminderLogReference(entry.customer, entry.stage),
              status: "failed",
              message_body: reminderMessage,
              external_message_id: null,
              last_error: errorMessage,
              sent_at: null,
            });
          }
        }

        const processedCount = index + 1;
        const sentLikeCount = results.filter(
          (result) => result.status === "sent" || result.status === "dry-run",
        ).length;
        const skippedCount = results.filter((result) => result.status === "skipped").length;
        const errorCount = results.filter((result) => result.status === "failed").length;

        logReminderProgress(logger, {
          label: "Overdue payment reminder",
          processed: processedCount,
          total: selectedRecords.length,
          sentCount: sentLikeCount,
          skippedCount,
          errorCount,
          lastContract: entry.customer.nr_contrato,
        });

        if (processedCount < selectedRecords.length) {
          await sleep(500);
        }
      }
    } finally {
      await client.logout().catch(() => undefined);
      await client.close();
    }

    const sentResults = results.filter(
      isOverdueSentResult,
    );
    const dryRunResults = results.filter(
      isOverdueDryRunResult,
    );
    const skippedResults = results.filter(
      (result): result is Extract<(typeof results)[number], { status: "skipped" }> =>
        result.status === "skipped",
    );
    const failedResults = results.filter(
      (result): result is Extract<(typeof results)[number], { status: "failed" }> =>
        result.status === "failed",
    );

    if (sendSummary && !dryRun && !payloadCustomers) {
      await sendExecutionSummary(
        [
          `Lembrete de inadimplência concluído em ${todayIso}.`,
          `${sentResults.length} mensagens enviadas, ${skippedResults.length} ignoradas e ${failedResults.length} falhas.`,
          `Elegíveis por régua hoje: ${stageEligibleRecords.length}.`,
        ].join("\n"),
      );
    }

    return {
      workflow: "overdue-payment-reminder",
      source: payloadCustomers ? "payload" : "database",
      dryRun,
      respectIdempotency,
      fetchedCount: fetchedRecords.length,
      activeCount: fetchedRecords.length,
      stageEligibleCount: stageEligibleRecords.length,
      selectedCount: selectedRecords.length,
      sentCount: sentResults.length,
      dryRunCount: dryRunResults.length,
      skippedCount: skippedResults.length,
      errorCount: failedResults.length,
      customersToSend: sentResults.map((result) => ({
        customer: result.customer,
        stage: result.stage,
        overdueDay: result.stage.overdueDay,
        selectedStrategy: result.selectedTarget.selectedStrategy,
        boletoCount: result.paymentInfo.boletos.length,
        selectedBoleto: {
          nr_parcela: result.selectedTarget.selectedBoleto.nr_parcela,
          ds_tipo: result.selectedTarget.selectedBoleto.ds_tipo,
          boleto_url: result.selectedTarget.selectedBoleto.boleto_url,
          pix_url: result.selectedTarget.selectedBoleto.pix_url,
        },
      })),
      results: results.map(summarizeResult),
    };
  },
});
