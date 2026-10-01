import {
  quoteCsvValue,
  supabaseRestGetAll,
  supabaseRestPatch,
  supabaseRestPost,
} from "./client.js";

export const PAYMENT_DUE_D2_REMINDER_TYPE = "payment_due_d2";
export const BIRTHDAY_REMINDER_TYPE = "birthday";
export const CONTEMPLATION_REMINDER_TYPE = "contemplation";
export const OVERDUE_PAYMENT_D1_REMINDER_TYPE = "overdue_payment_d1";
export const OVERDUE_PAYMENT_D7_REMINDER_TYPE = "overdue_payment_d7";
export const OVERDUE_PAYMENT_D14_REMINDER_TYPE = "overdue_payment_d14";
export const OFFER_FIDELIDADE_30_REMINDER_TYPE = "offer_fidelidade_30";
export const OFFER_FIDELIDADE_15_REMINDER_TYPE = "offer_fidelidade_15";
export const BID_COMPROVANTE_REMINDER_TYPE = "bid_comprovante";

export type ReminderLogStatus = "sent" | "skipped" | "failed";

export function isTerminalReminderLogStatus(
  status: ReminderLogStatus | undefined,
): boolean {
  return status === "sent" || status === "skipped";
}

export interface ReminderLogRow {
  id: string;
  idempotency_key: string;
  nr_contrato: string;
  nm_consorciado: string | null;
  cd_whatsapp: string | null;
  reminder_type: string;
  reference_date: string;
  status: ReminderLogStatus;
  message_body: string | null;
  external_message_id: string | null;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertReminderLogInput {
  idempotency_key: string;
  nr_contrato: string;
  nm_consorciado: string | null;
  cd_whatsapp: string | null;
  reminder_type: string;
  reference_date: string;
  status: ReminderLogStatus;
  message_body?: string | null;
  external_message_id?: string | null;
  last_error?: string | null;
  sent_at?: string | null;
}

export async function fetchReminderLogs(options: {
  reminderType?: string;
  referenceDates?: string[];
  idempotencyKeys?: string[];
  contracts?: string[];
}): Promise<ReminderLogRow[]> {
  const referenceDates = [...new Set((options.referenceDates ?? []).filter(Boolean))];
  const idempotencyKeys = [...new Set((options.idempotencyKeys ?? []).filter(Boolean))];
  const contracts = [...new Set((options.contracts ?? []).filter(Boolean))];

  if (options.referenceDates && referenceDates.length === 0) return [];
  if (options.idempotencyKeys && idempotencyKeys.length === 0) return [];
  if (options.contracts && contracts.length === 0) return [];

  let path = "/rest/v1/reminder_logs?select=*";

  if (options.reminderType) {
    path += `&reminder_type=eq.${encodeURIComponent(options.reminderType)}`;
  }

  if (referenceDates.length > 0) {
    path += `&reference_date=in.(${encodeURIComponent(
      referenceDates.map(quoteCsvValue).join(","),
    )})`;
  }

  if (idempotencyKeys.length > 0) {
    path += `&idempotency_key=in.(${encodeURIComponent(
      idempotencyKeys.map(quoteCsvValue).join(","),
    )})`;
  }

  if (contracts.length > 0) {
    path += `&nr_contrato=in.(${encodeURIComponent(
      contracts.map(quoteCsvValue).join(","),
    )})`;
  }

  return supabaseRestGetAll<ReminderLogRow>(path);
}

export async function upsertReminderLog(
  input: UpsertReminderLogInput,
): Promise<ReminderLogRow | null> {
  const body = {
    idempotency_key: input.idempotency_key,
    nr_contrato: input.nr_contrato,
    nm_consorciado: input.nm_consorciado,
    cd_whatsapp: input.cd_whatsapp,
    reminder_type: input.reminder_type,
    reference_date: input.reference_date,
    status: input.status,
    message_body: input.message_body ?? null,
    external_message_id: input.external_message_id ?? null,
    last_error: input.last_error ?? null,
    sent_at: input.sent_at ?? null,
  };

  const upsertResponse = await supabaseRestPost(
    "/rest/v1/reminder_logs?on_conflict=idempotency_key",
    [body],
    {
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation",
      },
    },
  );

  if (upsertResponse.ok) {
    const rows = (await upsertResponse.json()) as ReminderLogRow[];
    return rows[0] ?? null;
  }

  if (upsertResponse.status !== 409) {
    throw new Error(`Failed to upsert reminder log - HTTP ${upsertResponse.status}`);
  }

  let existingLogs = await fetchReminderLogs({
    idempotencyKeys: [input.idempotency_key],
  });

  let existingRow = existingLogs.find(
    (row) => row.idempotency_key === input.idempotency_key,
  );

  if (!existingRow) {
    existingLogs = await fetchReminderLogs({
      reminderType: input.reminder_type,
      referenceDates: [input.reference_date],
      contracts: [input.nr_contrato],
    });
    existingRow = existingLogs[0];
  }

  if (existingRow) {
    const patchResponse = await supabaseRestPatch(
      `/rest/v1/reminder_logs?id=eq.${existingRow.id}`,
      body,
      {
        headers: {
          Prefer: "return=representation",
        },
      },
    );

    if (!patchResponse.ok) {
      throw new Error(`Failed to update reminder log - HTTP ${patchResponse.status}`);
    }

    const rows = (await patchResponse.json()) as ReminderLogRow[];
    return rows[0] ?? null;
  }

  const insertResponse = await supabaseRestPost(
    "/rest/v1/reminder_logs",
    [body],
    {
      headers: {
        Prefer: "return=representation",
      },
    },
  );

  if (!insertResponse.ok) {
    throw new Error(`Failed to insert reminder log - HTTP ${insertResponse.status}`);
  }

  const rows = (await insertResponse.json()) as ReminderLogRow[];
  return rows[0] ?? null;
}
