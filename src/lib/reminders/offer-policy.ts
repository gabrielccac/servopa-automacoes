import type { CustomerLanceOption } from "../servopa/customer-lances.js";

export interface OfferStep {
  lanceType: "FIDELIDADE";
  pctLance: number;
  reminderType: string;
}
export interface TrackedLanceState {
  tp_lance: string | null;
  pct_lance: number | null;
}
export interface OfferGroupConfig {
  nr_grupo: number;
  hierarquia_fidelidade: number[];
  erro?: string;
}

export function parseGroupOfferHierarchy(group: number, rules: string | null): OfferGroupConfig {
  if (!rules?.trim()) return { nr_grupo: group, hierarquia_fidelidade: [], erro: "Missing group rules" };
  const normalized = rules.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ");
  const values = [...normalized.matchAll(/LANCE FIDELIDADE(?: DE)? (\d+(?:,\d+)?)\s*%/g)]
    .map((match) => Number(match[1].replace(",", ".")));
  if (values.some((value) => !Number.isInteger(value) || value <= 0 || value > 100) ||
    (!values.length && normalized.includes("FIDELIDADE"))) {
    return { nr_grupo: group, hierarquia_fidelidade: [], erro: "Unrecognized group Fidelidade rules" };
  }
  return { nr_grupo: group, hierarquia_fidelidade: [...new Set(values)].sort((a, b) => b - a) };
}

export function offerPrecheck(current: TrackedLanceState | null, group: OfferGroupConfig | undefined) {
  if (!group || group.erro) return "group_rules_unavailable" as const;
  if (!group.hierarquia_fidelidade.length) return "group_has_no_fidelidade" as const;
  if (!current?.tp_lance || current.pct_lance === null) return "unknown_current_lance" as const;
  const type = current.tp_lance.trim().toUpperCase();
  if (type !== "FIXO" && type !== "FIDELIDADE") return "unsupported_current_lance_type" as const;
  if (type === "FIDELIDADE") {
    const index = group.hierarquia_fidelidade.indexOf(current.pct_lance);
    if (index < 0) return "current_lance_not_in_group_hierarchy" as const;
    if (index === group.hierarquia_fidelidade.length - 1) return "already_at_last_tier" as const;
  }
  return null;
}

export function getNextOfferStep(
  current: TrackedLanceState | null,
  availableOptions: Array<Pick<CustomerLanceOption, "lance_type" | "pct_lance">>,
  hierarchy: number[],
): OfferStep | null {
  if (offerPrecheck(current, { nr_grupo: 0, hierarquia_fidelidade: hierarchy })) return null;
  const index = current!.tp_lance!.trim().toUpperCase() === "FIDELIDADE" ? hierarchy.indexOf(current!.pct_lance!) : -1;
  const pct = hierarchy.slice(index + 1).reverse().find((value) =>
    availableOptions.some((option) => option.lance_type === "FIDELIDADE" && option.pct_lance === value));
  return pct === undefined ? null : { lanceType: "FIDELIDADE", pctLance: pct, reminderType: `offer_fidelidade_${pct}` };
}
