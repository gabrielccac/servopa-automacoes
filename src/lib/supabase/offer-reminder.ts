import { quoteCsvValue, supabaseRestGetAll } from "./client.js";

export interface OfferReminderCandidate {
  nr_contrato: string | null;
  nm_consorciado: string | null;
  cd_whatsapp: string | null;
  nr_cota: string | null;
  nr_grupo: string | null;
  gp_fidelidade: boolean | null;
  dt_cancelamento: string | null;
  tp_lance: string | null;
}

export interface LanceStateRow {
  nr_contrato: string | null;
  tp_lance: string | null;
  pct_lance: number | null;
}

export async function fetchOfferReminderCandidates(options?: {
  contracts?: string[];
}): Promise<OfferReminderCandidate[]> {
  const filters = [
    "select=nr_contrato,nm_consorciado,cd_whatsapp,nr_cota,nr_grupo,gp_fidelidade,dt_cancelamento,tp_lance",
    "dt_cancelamento=is.null",
    "nr_contrato=not.is.null",
    "nr_cota=not.is.null",
    "nr_grupo=not.is.null",
  ];

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

  return supabaseRestGetAll<OfferReminderCandidate>(`/rest/v1/bd_producao?${filters.join("&")}`);
}

export async function fetchLanceStatesByContracts(
  contracts: string[],
): Promise<LanceStateRow[]> {
  const uniqueContracts = [...new Set(contracts.map((contract) => String(contract).trim()).filter(Boolean))];
  if (uniqueContracts.length === 0) {
    return [];
  }

  return supabaseRestGetAll<LanceStateRow>(
    `/rest/v1/lances?select=nr_contrato,tp_lance,pct_lance&nr_contrato=in.(${encodeURIComponent(
      uniqueContracts.map(quoteCsvValue).join(","),
    )})`,
  );
}
