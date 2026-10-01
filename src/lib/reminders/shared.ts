import { buildDateScopedReminderIdempotencyKey } from "../idempotency.js";
import { normalizePhone } from "../parsers.js";
import {
  fetchReminderLogs,
  isTerminalReminderLogStatus,
  upsertReminderLog,
} from "../supabase/reminder-logs.js";
import {
  getSendResponseExternalId,
  sendButtonActionsMessage,
  sendTextMessage,
  type ZApiButtonAction,
  type ZApiConfig,
  type ZApiSendTextResponse,
} from "../whatsapp/zapi.js";

export const PROGRESS_LOG_INTERVAL = 15;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ReminderPayload<TCustomer> {
  customer?: TCustomer;
  customers?: TCustomer[];
  dryRun?: boolean;
  respectIdempotency?: boolean;
  asOfDate?: string;
  sendSummary?: boolean;
}

export type ReminderTaskInput<TCustomer> =
  | TCustomer
  | TCustomer[]
  | ReminderPayload<TCustomer>
  | undefined;

export interface ParsedReminderPayload<TCustomer> {
  customers: TCustomer[] | null;
  dryRun: boolean;
  respectIdempotency: boolean;
  asOfDate: string | null;
  sendSummary: boolean;
}

export function parseAsOfDate(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("asOfDate must use YYYY-MM-DD format");
  }

  const date = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`asOfDate is not a valid calendar date: ${value}`);
  }

  return value;
}

export function isCustomerWithKeys(value: unknown, keys: string[]): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return keys.every((key) => key in record);
}

export function parseReminderPayload<TCustomer>(
  payload: ReminderTaskInput<TCustomer>,
  requiredCustomerKeys: string[],
): ParsedReminderPayload<TCustomer> {
  if (!payload) {
    return {
      customers: null,
      dryRun: false,
      respectIdempotency: false,
      asOfDate: null,
      sendSummary: true,
    };
  }

  if (Array.isArray(payload)) {
    return {
      customers: payload,
      dryRun: false,
      respectIdempotency: false,
      asOfDate: null,
      sendSummary: true,
    };
  }

  if (isCustomerWithKeys(payload, requiredCustomerKeys)) {
    return {
      customers: [payload as TCustomer],
      dryRun: false,
      respectIdempotency: false,
      asOfDate: null,
      sendSummary: true,
    };
  }

  const wrapper = payload as ReminderPayload<TCustomer>;

  if (wrapper.customer) {
    return {
      customers: [wrapper.customer],
      dryRun: Boolean(wrapper.dryRun),
      respectIdempotency: Boolean(wrapper.respectIdempotency),
      asOfDate: parseAsOfDate(wrapper.asOfDate),
      sendSummary: wrapper.sendSummary !== false,
    };
  }

  if (Array.isArray(wrapper.customers)) {
    return {
      customers: wrapper.customers,
      dryRun: Boolean(wrapper.dryRun),
      respectIdempotency: Boolean(wrapper.respectIdempotency),
      asOfDate: parseAsOfDate(wrapper.asOfDate),
      sendSummary: wrapper.sendSummary !== false,
    };
  }

  return {
    customers: null,
    dryRun: Boolean(wrapper.dryRun),
    respectIdempotency: Boolean(wrapper.respectIdempotency),
    asOfDate: parseAsOfDate(wrapper.asOfDate),
    sendSummary: wrapper.sendSummary !== false,
  };
}

export type ReminderSendMode = "button-actions" | "text" | "dry-run";

export async function sendReminderMessage(
  zapiConfig: ZApiConfig,
  input: {
    phone: string;
    message: string;
    buttonActions: ZApiButtonAction[];
    dryRun: boolean;
  },
): Promise<{ sendMode: ReminderSendMode; sendResponse: ZApiSendTextResponse | null }> {
  if (input.dryRun) {
    return { sendMode: "dry-run", sendResponse: null };
  }

  if (input.buttonActions.length > 0) {
    const sendResponse = await sendButtonActionsMessage(zapiConfig, {
      phone: input.phone,
      message: input.message,
      buttonActions: input.buttonActions,
    });
    return { sendMode: "button-actions", sendResponse };
  }

  const sendResponse = await sendTextMessage(zapiConfig, {
    phone: input.phone,
    message: input.message,
  });
  return { sendMode: "text", sendResponse };
}

export function logReminderProgress(
  logger: { log: (message: string, data?: Record<string, unknown>) => void },
  options: {
    label: string;
    processed: number;
    total: number;
    sentCount: number;
    skippedCount: number;
    errorCount: number;
    lastContract?: string | null;
  },
): void {
  const shouldLog =
    options.processed === 1 ||
    options.processed === options.total ||
    options.processed % PROGRESS_LOG_INTERVAL === 0;

  if (!shouldLog) return;

  logger.log(`${options.label} progress`, {
    processed: options.processed,
    total: options.total,
    percentComplete:
      options.total === 0
        ? 100
        : Math.round((options.processed / options.total) * 100),
    sentCount: options.sentCount,
    skippedCount: options.skippedCount,
    errorCount: options.errorCount,
    lastProcessedContract: options.lastContract,
  });
}

export type ReminderExecutionStatus = "sent" | "skipped" | "failed" | "dry-run";

export interface TextReminderResult<TCustomer> {
  customer: TCustomer;
  status: ReminderExecutionStatus;
  message: string | null;
  error?: string;
  reason?: string;
  sendResponse?: ZApiSendTextResponse | null;
}

export async function runTextReminderWorkflow<TCustomer>(
  options: {
    payload: ReminderTaskInput<TCustomer>;
    requiredCustomerKeys: string[];
    reminderType: string;
    referenceDate: string | ((asOfDate: string | null) => string);
    logger: { log: (message: string, data?: Record<string, unknown>) => void };
    label: string;
    fetchCustomers: (asOfDate?: string) => Promise<TCustomer[]>;
    buildMessage: (customer: TCustomer) => string;
    getContract: (customer: TCustomer) => string | null | undefined;
    getIdempotencyKeyValue?: (customer: TCustomer) => string | null | undefined;
    getName: (customer: TCustomer) => string | null | undefined;
    getPhoneValue: (customer: TCustomer) => string | null | undefined;
    getWhatsappForLog?: (customer: TCustomer) => string | null | undefined;
    zapiConfig: ZApiConfig;
  },
): Promise<{
  source: "database" | "payload";
  dryRun: boolean;
  respectIdempotency: boolean;
  fetchedCount: number;
  alreadyProcessedCount: number;
  selectedCount: number;
  sentCount: number;
  dryRunCount: number;
  skippedCount: number;
  errorCount: number;
  results: TextReminderResult<TCustomer>[];
}> {
  const { customers: payloadCustomers, dryRun, respectIdempotency, asOfDate } = parseReminderPayload(
    options.payload,
    options.requiredCustomerKeys,
  );
  const referenceDate =
    typeof options.referenceDate === "function"
      ? options.referenceDate(asOfDate)
      : options.referenceDate;
  const initialCustomers = payloadCustomers ?? (await options.fetchCustomers(asOfDate ?? undefined));
  const shouldApplyReminderLogFilter = !payloadCustomers || respectIdempotency;
  const shouldPersistLogs = !dryRun;
  const getIdempotencyKeyValue =
    options.getIdempotencyKeyValue ?? options.getContract;
  const dedupedCustomers: TCustomer[] = [];
  const seenDedupKeys = new Set<string>();

  for (const customer of initialCustomers) {
    const dedupKey = buildDateScopedReminderIdempotencyKey(
      options.reminderType,
      getIdempotencyKeyValue(customer) ?? null,
      referenceDate,
    );

    if (seenDedupKeys.has(dedupKey)) {
      continue;
    }

    seenDedupKeys.add(dedupKey);
    dedupedCustomers.push(customer);
  }

  const idempotencyKeys = dedupedCustomers.map((customer) =>
    buildDateScopedReminderIdempotencyKey(
      options.reminderType,
      getIdempotencyKeyValue(customer) ?? null,
      referenceDate,
    ),
  );
  const existingLogs =
    shouldApplyReminderLogFilter || shouldPersistLogs
      ? await fetchReminderLogs({
          reminderType: options.reminderType,
          idempotencyKeys,
        })
      : [];
  const existingByKey = new Map(existingLogs.map((log) => [log.idempotency_key, log]));
  const customers = shouldApplyReminderLogFilter
      ? dedupedCustomers.filter((customer) => {
        const idempotencyKey = buildDateScopedReminderIdempotencyKey(
          options.reminderType,
          getIdempotencyKeyValue(customer) ?? null,
          referenceDate,
        );
        return !isTerminalReminderLogStatus(existingByKey.get(idempotencyKey)?.status);
      })
    : dedupedCustomers;
  const results: TextReminderResult<TCustomer>[] = [];
  const source = payloadCustomers ? "payload" : "database";
  const alreadyProcessedCount = dedupedCustomers.length - customers.length;

  options.logger.log(`${options.label} started`, {
    source,
    dryRun,
    respectIdempotency,
    fetchedCount: initialCustomers.length,
    dedupedCount: dedupedCustomers.length,
    selectedCount: customers.length,
    alreadyProcessedCount,
    existingReminderLogCount: existingLogs.length,
  });

  for (const customer of customers) {
    const idempotencyKey = buildDateScopedReminderIdempotencyKey(
      options.reminderType,
      getIdempotencyKeyValue(customer) ?? null,
      referenceDate,
    );
    let reminderMessage: string | null = null;

    try {
      reminderMessage = options.buildMessage(customer);
      const phone = normalizePhone(options.getPhoneValue(customer) ?? null);

      if (!phone) {
        const skippedResult: TextReminderResult<TCustomer> = {
          customer,
          status: "skipped",
          message: reminderMessage,
          reason: "Customer does not have a valid WhatsApp number",
        };
        results.push(skippedResult);

        if (shouldPersistLogs) {
          await upsertReminderLog({
            idempotency_key: idempotencyKey,
            nr_contrato: String(options.getContract(customer) || "").trim(),
            nm_consorciado: options.getName(customer) ?? null,
            cd_whatsapp:
              options.getWhatsappForLog?.(customer) ?? options.getPhoneValue(customer) ?? null,
            reminder_type: options.reminderType,
            reference_date: referenceDate,
            status: "skipped",
            message_body: reminderMessage,
            last_error: null,
            sent_at: null,
          });
        }

        continue;
      }

      let sendResponse: ZApiSendTextResponse | null = null;
      let status: ReminderExecutionStatus = "dry-run";

      if (!dryRun) {
        sendResponse = await sendTextMessage(options.zapiConfig, {
          phone,
          message: reminderMessage,
        });
        status = "sent";
      }

      const successResult: TextReminderResult<TCustomer> = {
        customer,
        status,
        message: reminderMessage,
        sendResponse,
      };
      results.push(successResult);

      if (shouldPersistLogs) {
        await upsertReminderLog({
          idempotency_key: idempotencyKey,
          nr_contrato: String(options.getContract(customer) || "").trim(),
          nm_consorciado: options.getName(customer) ?? null,
          cd_whatsapp:
            options.getWhatsappForLog?.(customer) ?? options.getPhoneValue(customer) ?? null,
          reminder_type: options.reminderType,
          reference_date: referenceDate,
          status: "sent",
          message_body: reminderMessage,
          external_message_id: getSendResponseExternalId(sendResponse),
          last_error: null,
          sent_at: new Date().toISOString(),
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.push({
        customer,
        status: "failed",
        message: reminderMessage,
        error: errorMessage,
      });

      if (shouldPersistLogs) {
        await upsertReminderLog({
          idempotency_key: idempotencyKey,
          nr_contrato: String(options.getContract(customer) || "").trim(),
          nm_consorciado: options.getName(customer) ?? null,
          cd_whatsapp:
            options.getWhatsappForLog?.(customer) ?? options.getPhoneValue(customer) ?? null,
          reminder_type: options.reminderType,
          reference_date: referenceDate,
          status: "failed",
          message_body: reminderMessage,
          external_message_id: null,
          last_error: errorMessage,
          sent_at: null,
        });
      }
    }
  }

  const sentCount = results.filter((result) => result.status === "sent").length;
  const dryRunCount = results.filter((result) => result.status === "dry-run").length;
  const skippedCount = results.filter((result) => result.status === "skipped").length;
  const errorCount = results.filter((result) => result.status === "failed").length;

  options.logger.log(`${options.label} completed`, {
    source,
    dryRun,
    respectIdempotency,
    selectedCount: customers.length,
    sentCount,
    dryRunCount,
    skippedCount,
    errorCount,
  });

  return {
    source,
    dryRun,
    respectIdempotency,
    fetchedCount: initialCustomers.length,
    alreadyProcessedCount,
    selectedCount: customers.length,
    sentCount,
    dryRunCount,
    skippedCount,
    errorCount,
    results,
  };
}
