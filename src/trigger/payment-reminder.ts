import { logger, task } from "@trigger.dev/sdk";
import { getConfig } from "../lib/config.js";
import { getCustomerPaymentInfo } from "../lib/servopa/customer-payment-info.js";
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
  fetchUpcomingPaymentReminderCustomers,
  getDayAfterTomorrowIsoDateInSaoPaulo,
  type Customer,
} from "../lib/supabase/customers.js";
import {
  fetchReminderLogs,
  isTerminalReminderLogStatus,
  PAYMENT_DUE_D2_REMINDER_TYPE,
  upsertReminderLog,
} from "../lib/supabase/reminder-logs.js";
import { buildPaymentDueD1Message } from "../lib/whatsapp/templates.js";
import {
  getSendResponseExternalId,
  getZApiConfig,
  sendExecutionSummary,
  type ZApiButtonAction,
  type ZApiSendTextResponse,
} from "../lib/whatsapp/zapi.js";

type PaymentReminderTaskInput = ReminderTaskInput<Customer>;

const PAYMENT_CUSTOMER_KEYS = ["nr_contrato", "nr_cota", "nr_grupo", "cd_whatsapp"];

type PaymentReminderResult =
  | {
      customer: Customer;
      status: "failed";
      error: string;
    }
  | {
      customer: Customer;
      status: "skipped";
      reason: string;
      paymentInfo: Awaited<ReturnType<typeof getCustomerPaymentInfo>>;
    }
  | {
      customer: Customer;
      status: "sent" | "dry-run";
      paymentInfo: Awaited<ReturnType<typeof getCustomerPaymentInfo>>;
      reminderMessage: string;
      sendMode: "button-actions" | "text" | "dry-run";
      sendResponse: ZApiSendTextResponse | null;
    };

function toCustomerRef(customer: Customer): ServopaCustomerRef {
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

function getPrimaryBoleto(
  paymentInfo: Awaited<ReturnType<typeof getCustomerPaymentInfo>>,
) {
  if (paymentInfo.boletos.length === 0) {
    return null;
  }

  return [...paymentInfo.boletos].sort((left, right) => {
    const leftParcela = left.nr_parcela ?? -1;
    const rightParcela = right.nr_parcela ?? -1;

    if (rightParcela !== leftParcela) {
      return rightParcela - leftParcela;
    }

    return 0;
  })[0];
}

function buildButtonActions(
  paymentInfo: Awaited<ReturnType<typeof getCustomerPaymentInfo>>,
): ZApiButtonAction[] {
  const boleto = getPrimaryBoleto(paymentInfo);
  if (!boleto) return [];

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

function summarizePaymentReminderResult(result: PaymentReminderResult) {
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
      customerContextConfirmed: result.paymentInfo.customerContextConfirmed,
      boletoCount: result.paymentInfo.boletos.length,
      parcelaCount: result.paymentInfo.parcelas.length,
    };
  }

  const primaryBoleto = getPrimaryBoleto(result.paymentInfo);

  return {
    customer: result.customer,
    status: result.status,
    customerContextConfirmed: result.paymentInfo.customerContextConfirmed,
    boletoCount: result.paymentInfo.boletos.length,
    parcelaCount: result.paymentInfo.parcelas.length,
    primaryBoleto: primaryBoleto
      ? {
          nr_parcela: primaryBoleto.nr_parcela,
          ds_tipo: primaryBoleto.ds_tipo,
          vl_emitido: primaryBoleto.vl_emitido,
          vl_atual: primaryBoleto.vl_atual,
          boleto_url: primaryBoleto.boleto_url,
          pix_url: primaryBoleto.pix_url,
        }
      : null,
    reminderMessage: result.reminderMessage,
    sendMode: result.sendMode,
    sendResponse: result.sendResponse,
  };
}

export const paymentReminder = task({
  id: "payment-reminder",
  maxDuration: 900,
  queue: { concurrencyLimit: 1 },
  run: async (payload: unknown) => {
    const { customers: payloadCustomers, dryRun, respectIdempotency, asOfDate, sendSummary } =
      parseReminderPayload(payload as PaymentReminderTaskInput, PAYMENT_CUSTOMER_KEYS);
    const initialCustomers =
      payloadCustomers ?? (await fetchUpcomingPaymentReminderCustomers(asOfDate ?? undefined));
    const fetchedCount = initialCustomers.length;
    const shouldApplyReminderLogFilter = !payloadCustomers || respectIdempotency;
    const shouldPersistReminderLogs = !dryRun;
    const client = new HttpClient(getConfig().servopa);
    const zapiConfig = getZApiConfig();
    const referenceDate = getDayAfterTomorrowIsoDateInSaoPaulo(
      asOfDate ? new Date(`${asOfDate}T12:00:00.000Z`) : new Date(),
    );
    const idempotencyKeys = initialCustomers.map((customer) =>
      buildDateScopedReminderIdempotencyKey(
        PAYMENT_DUE_D2_REMINDER_TYPE,
        customer.nr_contrato,
        referenceDate,
      ),
    );
    const existingLogs =
      shouldApplyReminderLogFilter || shouldPersistReminderLogs
        ? await fetchReminderLogs({
            reminderType: PAYMENT_DUE_D2_REMINDER_TYPE,
            idempotencyKeys,
          })
        : [];
    const existingLogsByKey = new Map(existingLogs.map((log) => [log.idempotency_key, log]));
    const customers = shouldApplyReminderLogFilter
      ? initialCustomers.filter((customer) => {
          const idempotencyKey = buildDateScopedReminderIdempotencyKey(
            PAYMENT_DUE_D2_REMINDER_TYPE,
            customer.nr_contrato,
            referenceDate,
          );
          return !isTerminalReminderLogStatus(existingLogsByKey.get(idempotencyKey)?.status);
        })
      : initialCustomers;

    const alreadyProcessedCount = initialCustomers.length - customers.length;
    const results: PaymentReminderResult[] = [];

    logger.log("Payment reminder selection summary", {
      source: payloadCustomers ? "payload" : "database",
      dryRun,
      respectIdempotency,
      appliedReminderLogFilter: shouldApplyReminderLogFilter,
      totalDueCustomersFetched: fetchedCount,
      existingReminderLogCount: existingLogs.length,
      alreadyProcessedCount,
      customersSelectedForRun: customers.length,
    });

    try {
      await client.login();

      for (const [index, customer] of customers.entries()) {
        const idempotencyKey = buildDateScopedReminderIdempotencyKey(
          PAYMENT_DUE_D2_REMINDER_TYPE,
          customer.nr_contrato,
          referenceDate,
        );
        let reminderMessage: string | null = null;

        try {
          const customerRef = toCustomerRef(customer);
          const paymentInfo = await getCustomerPaymentInfo(client, customerRef);
          reminderMessage = buildPaymentDueD1Message(
            customer.nm_consorciado,
            customer.nr_cota,
          ).replace("vence amanhÃ£!", "vence em dois dias!");

          if (paymentInfo.paymentStatus !== "eligible") {
            const skippedResult: PaymentReminderResult = {
              customer,
              status: "skipped",
              reason:
                paymentInfo.message ?? "Payment information is not available right now",
              paymentInfo,
            };
            results.push(skippedResult);

            if (shouldPersistReminderLogs) {
              await upsertReminderLog({
                idempotency_key: idempotencyKey,
                nr_contrato: String(customer.nr_contrato || "").trim(),
                nm_consorciado: customer.nm_consorciado,
                cd_whatsapp: customer.cd_whatsapp,
                reminder_type: PAYMENT_DUE_D2_REMINDER_TYPE,
                reference_date: referenceDate,
                status: "skipped",
                message_body: reminderMessage,
                last_error: null,
                sent_at: null,
              });
            }
          } else {
            const phone = normalizePhone(customer.cd_whatsapp);
            if (!phone) {
              const skippedResult: PaymentReminderResult = {
                customer,
                status: "skipped",
                reason: "Customer does not have a valid WhatsApp number",
                paymentInfo,
              };
              results.push(skippedResult);

              if (shouldPersistReminderLogs) {
                await upsertReminderLog({
                  idempotency_key: idempotencyKey,
                  nr_contrato: String(customer.nr_contrato || "").trim(),
                  nm_consorciado: customer.nm_consorciado,
                  cd_whatsapp: customer.cd_whatsapp,
                  reminder_type: PAYMENT_DUE_D2_REMINDER_TYPE,
                  reference_date: referenceDate,
                  status: "skipped",
                  message_body: reminderMessage,
                  last_error: null,
                  sent_at: null,
                });
              }
            } else {
              const buttonActions = buildButtonActions(paymentInfo);
              const { sendMode, sendResponse } = await sendReminderMessage(zapiConfig, {
                phone,
                message: reminderMessage,
                buttonActions,
                dryRun,
              });
              const status = dryRun ? "dry-run" : "sent";

              results.push({
                customer,
                status,
                paymentInfo,
                reminderMessage,
                sendMode,
                sendResponse,
              });

              if (shouldPersistReminderLogs) {
                await upsertReminderLog({
                  idempotency_key: idempotencyKey,
                  nr_contrato: String(customer.nr_contrato || "").trim(),
                  nm_consorciado: customer.nm_consorciado,
                  cd_whatsapp: customer.cd_whatsapp,
                  reminder_type: PAYMENT_DUE_D2_REMINDER_TYPE,
                  reference_date: referenceDate,
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
            customer,
            status: "failed",
            error: errorMessage,
          });

          if (shouldPersistReminderLogs) {
            await upsertReminderLog({
              idempotency_key: idempotencyKey,
              nr_contrato: String(customer.nr_contrato || "").trim(),
              nm_consorciado: customer.nm_consorciado,
              cd_whatsapp: customer.cd_whatsapp,
              reminder_type: PAYMENT_DUE_D2_REMINDER_TYPE,
              reference_date: referenceDate,
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
          label: "Payment reminder",
          processed: processedCount,
          total: customers.length,
          sentCount: sentLikeCount,
          skippedCount,
          errorCount,
          lastContract: customer.nr_contrato,
        });

        if (processedCount < customers.length) {
          await sleep(500);
        }
      }
    } finally {
      await client.logout().catch(() => undefined);
      await client.close();
    }

    const sentResults = results.filter(
      (result): result is Extract<(typeof results)[number], { status: "sent" }> =>
        result.status === "sent",
    );
    const dryRunResults = results.filter(
      (result): result is Extract<(typeof results)[number], { status: "dry-run" }> =>
        result.status === "dry-run",
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
          `Lembrete de pagamento concluído para vencimento em ${referenceDate}.`,
          `${sentResults.length} mensagens enviadas, ${skippedResults.length} ignoradas e ${failedResults.length} falhas.`,
        ].join("\n"),
      );
    }

    return {
      workflow: "payment-reminder",
      source: payloadCustomers ? "payload" : "database",
      dryRun,
      respectIdempotency,
      fetchedCount,
      alreadyProcessedCount,
      selectedCount: customers.length,
      sentCount: sentResults.length,
      dryRunCount: dryRunResults.length,
      skippedCount: skippedResults.length,
      errorCount: failedResults.length,
      results: results.map(summarizePaymentReminderResult),
    };
  },
});
