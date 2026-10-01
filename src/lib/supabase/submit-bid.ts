import { quoteCsvValue, supabaseRestGetAll } from "./client.js";

export interface SubmitBidLanceRow {
  nr_contrato: string | null;
  tp_lance: string | null;
  pct_lance: number | null;
  diluicao_em_parcelas?: string | boolean | null;
}

export interface SubmitBidCustomerContextRow {
  nr_contrato: string | null;
  nm_consorciado: string | null;
  cd_whatsapp: string | null;
  nr_cota: string | null;
  nr_grupo: string | null;
  nr_diavenc: number | null;
  dt_cancelamento: string | null;
}

export interface SubmitBidCandidate extends SubmitBidLanceRow {
  nr_contrato: string | null;
  nm_consorciado: string | null;
  cd_whatsapp: string | null;
  nr_cota: string | null;
  nr_grupo: string | null;
  dt_venc: number | null;
  dt_cancelamento: string | null;
}

export async function fetchSubmitBidLanceRows(options?: {
  contracts?: string[];
}): Promise<SubmitBidLanceRow[]> {
  const filters = ["select=nr_contrato,tp_lance,pct_lance,diluicao_em_parcelas"];

  if (options?.contracts?.length) {
    const uniqueContracts = [
      ...new Set(options.contracts.map((contract) => String(contract).trim()).filter(Boolean)),
    ];

    if (uniqueContracts.length === 0) {
      return [];
    }

    filters.push(
      `nr_contrato=in.(${encodeURIComponent(uniqueContracts.map(quoteCsvValue).join(","))})`,
    );
  }

  return supabaseRestGetAll<SubmitBidLanceRow>(`/rest/v1/lances?${filters.join("&")}`);
}

export async function fetchSubmitBidCustomerContextByContracts(
  contracts: string[],
): Promise<SubmitBidCustomerContextRow[]> {
  const uniqueContracts = [...new Set(contracts.map((contract) => String(contract).trim()).filter(Boolean))];
  if (uniqueContracts.length === 0) {
    return [];
  }

  return supabaseRestGetAll<SubmitBidCustomerContextRow>(
    `/rest/v1/bd_producao?select=nr_contrato,nm_consorciado,cd_whatsapp,nr_cota,nr_grupo,nr_diavenc,dt_cancelamento&nr_contrato=in.(${encodeURIComponent(
      uniqueContracts.map(quoteCsvValue).join(","),
    )})`,
  );
}

export async function fetchSubmitBidCandidates(options?: {
  contracts?: string[];
  dtVenc?: number | null;
}): Promise<SubmitBidCandidate[]> {
  const lanceRows = await fetchSubmitBidLanceRows(options);
  const contextRows = await fetchSubmitBidCustomerContextByContracts(
    lanceRows.map((row) => String(row.nr_contrato || "").trim()),
  );
  const contextByContract = new Map(
    contextRows
      .filter((row): row is SubmitBidCustomerContextRow & { nr_contrato: string } => Boolean(row.nr_contrato))
      .map((row) => [row.nr_contrato, row]),
  );

  const candidates = lanceRows.map((lanceRow) => {
    const contract = String(lanceRow.nr_contrato || "").trim();
    const context = contextByContract.get(contract);

    return {
      ...lanceRow,
      nr_contrato: contract || null,
      nm_consorciado: context?.nm_consorciado ?? null,
      cd_whatsapp: context?.cd_whatsapp ?? null,
      nr_cota: context?.nr_cota ?? null,
      nr_grupo: context?.nr_grupo ?? null,
      dt_venc: context?.nr_diavenc ?? null,
      dt_cancelamento: context?.dt_cancelamento ?? null,
    } satisfies SubmitBidCandidate;
  });

  if (options?.dtVenc === null || options?.dtVenc === undefined) {
    return candidates;
  }

  return candidates.filter((candidate) => candidate.dt_venc === options.dtVenc);
}
