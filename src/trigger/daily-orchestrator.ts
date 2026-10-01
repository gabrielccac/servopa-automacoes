import { logger, schedules, wait } from "@trigger.dev/sdk";
import { parseAsOfDate } from "../lib/reminders/shared.js";
import { getTodayIsoDateInSaoPaulo } from "../lib/supabase/customers.js";
import { sendExecutionSummary } from "../lib/whatsapp/zapi.js";
import { birthdayReminder } from "./birthday-reminder.js";
import { contemplationReminder } from "./contemplation-reminder.js";
import { dailySync } from "./daily-sync.js";
import { overduePaymentReminder } from "./overdue-payment-reminder.js";
import { paymentReminder } from "./payment-reminder.js";
import { verifyActiveCustomers } from "./verify-active-customers.js";

interface DailyOrchestratorInput {
  dryRun?: boolean;
  asOfDate?: unknown;
  verbose?: boolean;
}

interface ReminderRunResult {
  workflow: string;
  status: "completed" | "failed";
  output?: unknown;
  error?: string;
}

function parseInput(payload: unknown): DailyOrchestratorInput {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as DailyOrchestratorInput)
    : {};
}

function getNoonInSaoPaulo(date: string): Date {
  return new Date(`${date}T15:00:00.000Z`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getNumber(value: unknown, key: string): number {
  const candidate = asRecord(value)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
}

function formatReminderSummary(
  label: string,
  output: unknown,
  extra?: { key: string; label: string },
): string {
  const details = [
    `${getNumber(output, "sentCount")} enviadas`,
    `${getNumber(output, "skippedCount")} ignoradas`,
    `${getNumber(output, "errorCount")} falhas`,
  ];

  if (extra) {
    details.push(`${extra.label}: ${getNumber(output, extra.key)}`);
  }

  return `${label}: ${details.join(", ")}.`;
}

export function buildDailyExecutionSummary(input: {
  date: string;
  sync: unknown;
  activeVerification: unknown;
  birthday: unknown;
  contemplation: unknown;
  payment: unknown;
  overdue: unknown;
}): string {
  const sync = asRecord(asRecord(input.sync).sync);
  const bdProducao = asRecord(sync.bdProducao);
  const bdClientes = asRecord(sync.bdClientes);
  const assembleias = asRecord(sync.resultadoUltimasAssembleias);
  const disponivel = asRecord(sync.disponivelParaVender);
  const inadimplentes = asRecord(sync.inadimplentes);
  const fidelidade = asRecord(asRecord(sync.fidelidade).fidelidadeSync);
  const active = asRecord(asRecord(input.activeVerification).summary);

  return [
    `Resumo diário — ${input.date}.`,
    `Extração: bd_producao ${getNumber(bdProducao, "rowCount")}, bd_clientes ${getNumber(bdClientes, "rowCount")}, assembleias ${getNumber(assembleias, "rowCount")}, disponível para vender ${getNumber(disponivel, "rowCount")} linhas.`,
    `Inadimplentes sincronizados: ${getNumber(inadimplentes, "rowCount")} linhas (${getNumber(inadimplentes, "insertedCount")} novas, ${getNumber(inadimplentes, "updatedCount")} atualizadas, ${getNumber(inadimplentes, "closedCount")} encerradas).`,
    `Fidelidade: ${getNumber(fidelidade, "updatedTrueCount")} true, ${getNumber(fidelidade, "updatedFalseCount")} false.`,
    `Clientes ativos: ${getNumber(active, "verifiedActiveCount")} verificados, ${getNumber(active, "customersToActivateCount")} ativados, ${getNumber(active, "customersToInactivateCount")} inativados.`,
    formatReminderSummary("Aniversários", input.birthday),
    formatReminderSummary("Contemplações", input.contemplation),
    formatReminderSummary("Lembrete de pagamento", input.payment, {
      key: "selectedCount",
      label: "selecionadas",
    }),
    formatReminderSummary("Inadimplência", input.overdue, {
      key: "stageEligibleCount",
      label: "elegíveis",
    }),
  ].join("\n");
}

export const dailyOrchestrator = schedules.task({
  id: "daily-orchestrator",
  cron: { pattern: "0 8 * * *", timezone: "America/Sao_Paulo" },
  maxDuration: 3600,
  retry: { maxAttempts: 1 },
  queue: { concurrencyLimit: 1 },
  run: async (payload: unknown) => {
    const input = parseInput(payload);
    const dryRun = input.dryRun ?? false;
    const asOfDate = parseAsOfDate(input.asOfDate);
    const childPayload = {
      dryRun,
      sendSummary: false,
      ...(asOfDate ? { asOfDate } : {}),
      ...(input.verbose ? { verbose: true } : {}),
    };

    logger.log("Daily orchestration started", { dryRun, asOfDate });

    const syncOutput = await dailySync.triggerAndWait(childPayload).unwrap();
    logger.log("Daily sync completed");

    const reminderResults: ReminderRunResult[] = [];
    const paymentResult = await paymentReminder.triggerAndWait(childPayload);
    if (paymentResult.ok) {
      reminderResults.push({
        workflow: "payment-reminder",
        status: "completed",
        output: paymentResult.output,
      });
      logger.log("payment-reminder completed");
    } else {
      const error = String(paymentResult.error);
      reminderResults.push({ workflow: "payment-reminder", status: "failed", error });
      logger.error("payment-reminder failed", { error });
    }

    const activeVerificationOutput = await verifyActiveCustomers
      .triggerAndWait(childPayload)
      .unwrap();
    logger.log("Active-customer verification completed");

    const reminders = [
      ["birthday-reminder", birthdayReminder],
      ["contemplation-reminder", contemplationReminder],
    ] as const;

    for (const [workflow, reminder] of reminders) {
      const result = await reminder.triggerAndWait(childPayload);
      if (result.ok) {
        reminderResults.push({ workflow, status: "completed", output: result.output });
        logger.log(`${workflow} completed`);
      } else {
        const error = String(result.error);
        reminderResults.push({ workflow, status: "failed", error });
        logger.error(`${workflow} failed`, { error });
      }
    }

    if (!dryRun && !asOfDate) {
      await wait.until({ date: getNoonInSaoPaulo(getTodayIsoDateInSaoPaulo()) });
    }

    const overdueResult = await overduePaymentReminder.triggerAndWait(childPayload);
    let overdueOutput: unknown = null;
    if (overdueResult.ok) {
      overdueOutput = overdueResult.output;
      reminderResults.push({
        workflow: "overdue-payment-reminder",
        status: "completed",
        output: overdueResult.output,
      });
      logger.log("Overdue-payment reminder completed");
    } else {
      const error = String(overdueResult.error);
      reminderResults.push({ workflow: "overdue-payment-reminder", status: "failed", error });
      logger.error("overdue-payment-reminder failed", { error });
    }

    const resultByWorkflow = new Map(
      reminderResults.map((result) => [result.workflow, result]),
    );
    const summary = buildDailyExecutionSummary({
      date: asOfDate ?? getTodayIsoDateInSaoPaulo(),
      sync: syncOutput,
      activeVerification: activeVerificationOutput,
      birthday: resultByWorkflow.get("birthday-reminder")?.output,
      contemplation: resultByWorkflow.get("contemplation-reminder")?.output,
      payment: resultByWorkflow.get("payment-reminder")?.output,
      overdue: overdueOutput,
    });

    let summarySent = false;
    let summaryError: string | undefined;
    if (!dryRun) {
      try {
        await sendExecutionSummary(summary);
        summarySent = true;
      } catch (error) {
        summaryError = error instanceof Error ? error.message : String(error);
        logger.error("Daily execution summary failed", { error: summaryError });
      }
    }

    const failedReminders = reminderResults.filter((result) => result.status === "failed");
    if (failedReminders.length > 0) {
      throw new Error(
        `Daily orchestration completed with failed reminders: ${failedReminders
          .map((result) => result.workflow)
          .join(", ")}`,
      );
    }

    return {
      workflow: "daily-orchestrator",
      dryRun,
      asOfDate,
      summarySent,
      ...(summaryError ? { summaryError } : {}),
      order: [
        "daily-sync",
        "payment-reminder",
        "verify-active-customers",
        "birthday-reminder",
        "contemplation-reminder",
        "overdue-payment-reminder",
      ],
      syncCompleted: Boolean(syncOutput),
      reminderResults,
    };
  },
});
