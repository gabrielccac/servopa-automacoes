import { quoteCsvValue, supabaseRestGetAll, supabaseRestPost } from "./client.js";

export interface BidLogRow {
  id: number;
  created_at: string;
  updated_at: string | null;
  nr_contrato: string;
  nm_consorciado: string | null;
  nr_cota: string | null;
  nr_grupo: string | null;
  tp_lance: string | null;
  pct_lance: number | null;
  reference_month: string;
  idempotency_key: string;
  status: "submitted" | "failed";
  protocolo: string | null;
  url_comprovante: string | null;
  last_error: string | null;
}

export interface UpsertBidLogInput {
  nr_contrato: string;
  nm_consorciado: string | null;
  nr_cota: string | null;
  nr_grupo: string | null;
  tp_lance: string | null;
  pct_lance: number | null;
  reference_month: string;
  idempotency_key: string;
  status: "submitted" | "failed";
  protocolo?: string | null;
  url_comprovante?: string | null;
  last_error?: string | null;
}

export async function fetchSubmittedBidLogsForReferenceMonth(
  referenceMonth: string,
): Promise<BidLogRow[]> {
  return supabaseRestGetAll<BidLogRow>(
    `/rest/v1/lances_submetidos?select=*&reference_month=eq.${encodeURIComponent(
      referenceMonth,
    )}&status=eq.submitted`,
  );
}

export async function upsertBidLog(input: UpsertBidLogInput): Promise<BidLogRow | null> {
  const response = await supabaseRestPost(
    "/rest/v1/lances_submetidos?on_conflict=idempotency_key",
    [
      {
        nr_contrato: input.nr_contrato,
        nm_consorciado: input.nm_consorciado,
        nr_cota: input.nr_cota,
        nr_grupo: input.nr_grupo,
        tp_lance: input.tp_lance,
        pct_lance: input.pct_lance,
        reference_month: input.reference_month,
        idempotency_key: input.idempotency_key,
        status: input.status,
        protocolo: input.protocolo ?? null,
        url_comprovante: input.url_comprovante ?? null,
        last_error: input.last_error ?? null,
      },
    ],
    {
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation",
      },
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to upsert bid log - HTTP ${response.status}: ${body}`);
  }

  const rows = (await response.json()) as BidLogRow[];
  return rows[0] ?? null;
}

export function buildBidSubmissionIdempotencyKey(
  nrContrato: string,
  referenceMonth: string,
): string {
  return `submit_bid:${nrContrato.trim()}:${referenceMonth}`;
}

export function buildContractInFilter(contracts: string[]): string {
  return encodeURIComponent(contracts.map(quoteCsvValue).join(","));
}
