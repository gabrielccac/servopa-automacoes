import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { getConfig } from "../config.js";
import { HttpClient } from "../servopa/http-client.js";
import {
  parseGroupListing, parseGroupDetails, parseGroupHistory, groupPlanKey,
  type GroupPlan, type GroupAssembly, type GroupBidHistory, type GroupSection,
} from "../servopa/groups.js";
import { supabaseRestGetAll, supabaseRestPost } from "./client.js";

type Details = ReturnType<typeof parseGroupDetails>;
type Characteristics = Extract<Details["cadastro"], { status: "ok" }>["data"];
export type GroupRow = Partial<Characteristics & ReturnType<typeof parseGroupListing>> & {
  nr_grupo: number;
  planos?: GroupPlan[] | null;
  assembleias?: GroupAssembly[] | null;
  historico_lances?: GroupBidHistory[] | null;
  atualizacao_secoes?: Record<string, string>;
  ultima_visualizacao_em?: string;
  created_at?: string;
  updated_at?: string;
};
type Sections = Details & { historico_com_embutido: GroupSection<GroupBidHistory[]> };
export interface GroupSyncPayload { groups?: number[]; dryRun?: boolean }

function mergeRecords<T>(old: T[], current: T[], key: (item: T) => string): T[] {
  const merged = new Map(old.map((item) => [key(item), item]));
  for (const item of current) merged.set(key(item), item);
  return [...merged.values()];
}
export function mergeGroupData(previous: GroupRow | undefined, group: number,
  listing: ReturnType<typeof parseGroupListing>, sections: Sections, now: string): GroupRow {
  const next: GroupRow = { ...previous, nr_grupo: group, ...listing,
    atualizacao_secoes: { ...previous?.atualizacao_secoes, listagem: now },
    ultima_visualizacao_em: now, updated_at: now };
  for (const [name, section] of Object.entries(sections)) {
    if (section.status === "ok") next.atualizacao_secoes![name] = now;
  }
  if (sections.cadastro.status === "ok") Object.assign(next, sections.cadastro.data);
  if (sections.planos.status === "ok") {
    const current = sections.planos.data.map((plan) => ({ ...plan, disponivel: true, ultima_visualizacao_em: now }));
    next.planos = mergeRecords((previous?.planos ?? []).map((plan) => ({ ...plan, disponivel: false })), current, groupPlanKey);
  }
  if (sections.assembleias.status === "ok") {
    next.assembleias = mergeRecords(previous?.assembleias ?? [], sections.assembleias.data, (row) => String(row.numero));
  }
  const histories = [sections.historico_sem_embutido, sections.historico_com_embutido];
  if (histories.some((section) => section.status === "ok")) {
    next.historico_lances = mergeRecords(previous?.historico_lances ?? [],
      histories.flatMap((section) => section.status === "ok" ? section.data : []),
      (row) => `${row.assembleia_numero}:${row.modalidade}`);
  }
  return next;
}
function businessData(row: GroupRow | undefined) {
  if (!row) return null;
  const { created_at: _created, updated_at: _updated, ultima_visualizacao_em: _seen, atualizacao_secoes: _sections,
    planos, ...data } = row;
  // Database defaults and metadata do not constitute a business change.
  return { ...data,
    proxima_assembleia_em: data.proxima_assembleia_em ? new Date(data.proxima_assembleia_em).toISOString() : null,
    planos: planos?.map(({ ultima_visualizacao_em: _seen, ...plan }) => plan) };
}
async function write(path: string, body: unknown, upsert = false): Promise<void> {
  const response = await supabaseRestPost(path, body, {
    headers: { Prefer: `${upsert ? "resolution=merge-duplicates," : ""}return=minimal` },
  });
  if (!response.ok) throw new Error(`Group database write failed - HTTP ${response.status}`);
}
export async function runGroupSync(payload: GroupSyncPayload = {}, runId?: string,
  logger: { log: (message: string, data?: Record<string, unknown>) => void } = console) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
    (payload.dryRun !== undefined && typeof payload.dryRun !== "boolean") ||
    (payload.groups !== undefined && (!Array.isArray(payload.groups) ||
      payload.groups.some((g) => !Number.isSafeInteger(g) || g <= 0 || g > 9999)))) {
    throw new Error("Group sync requires groups as positive integers up to 9999 and dryRun as a boolean");
  }
  const dryRun = payload.dryRun ?? false;
  const [source, existing] = await Promise.all([
    supabaseRestGetAll<{ nr_grupo: number | string }>("/rest/v1/bd_producao?select=nr_grupo&nr_grupo=not.is.null"),
    supabaseRestGetAll<GroupRow>("/rest/v1/grupos?select=*"),
  ]);
  const rawGroups = payload.groups ?? [...source.map((row) => Number(row.nr_grupo)), ...existing.map((row) => row.nr_grupo)];
  if (rawGroups.some((g) => !Number.isSafeInteger(g) || g <= 0 || g > 9999)) throw new Error("Invalid group number in database source");
  const groups = [...new Set(rawGroups)].sort((a, b) => a - b);
  const existingByGroup = new Map(existing.map((row) => [row.nr_grupo, row]));
  const results: { nr_grupo: number; status: "sucesso" | "parcial" | "falha"; alterado: boolean;
    secoes: Record<string, { status: string; quantidade?: number; erro?: string }>; erro?: string }[] = [];
  logger.log("Group sync started", { dryRun, groupCount: groups.length });
  if (!groups.length) return { workflow: "groups-sync", dryRun, groupCount: 0, errorCount: 0, results };
  const client = new HttpClient({ ...getConfig().servopa, timeout: 30_000 });
  try {
    let loginError: unknown;
    try { await client.login(); } catch (error) { loginError = error; }
    for (const group of groups) {
      const started = new Date().toISOString();
      const result: typeof results[number] = { nr_grupo: group, status: "falha", alterado: false, secoes: {} };
      try {
        if (loginError) throw loginError;
        const listingResponse = await client.post("/vendas/grupos",
          new URLSearchParams({ grupofrm: String(group), tp_lance: "S" }), { retrySafe: true });
        if (!listingResponse.ok) throw new Error(`Group search failed - HTTP ${listingResponse.status}`);
        const listing = parseGroupListing(await listingResponse.text(), group);
        const detailResponse = await client.get(`/vendas/grupos/${group}/S`);
        if (!detailResponse.ok) throw new Error(`Group details failed - HTTP ${detailResponse.status}`);
        const details = parseGroupDetails(await detailResponse.text(), group);
        let embedded: GroupSection<GroupBidHistory[]>;
        try {
          const response = await client.get(`/vendas/grupos/${group}/L`);
          if (!response.ok) throw new Error(`Embedded group history failed - HTTP ${response.status}`);
          embedded = parseGroupHistory(await response.text(), group, "com_embutido");
        } catch (error) {
          embedded = { status: "falha", erro: error instanceof Error ? error.message : String(error) };
        }
        const sections = { ...details, historico_com_embutido: embedded };
        result.secoes.listagem = { status: "ok" };
        for (const [name, section] of Object.entries(sections)) {
          result.secoes[name] = { status: section.status,
            ...(section.status === "ok" && Array.isArray(section.data) ? { quantidade: section.data.length } : {}),
            ...(section.status === "falha" ? { erro: section.erro } : {}) };
        }
        const now = new Date().toISOString();
        const previous = existingByGroup.get(group);
        const next = mergeGroupData(previous, group, listing, sections, now);
        result.alterado = !isDeepStrictEqual(businessData(previous), businessData(next));
        if (!dryRun) await write("/rest/v1/grupos?on_conflict=nr_grupo", [next], true);
        result.status = Object.values(sections).some((section) => section.status === "falha") ? "parcial" : "sucesso";
        result.erro = Object.entries(result.secoes).filter(([, section]) => section.erro)
          .map(([name, section]) => `${name}: ${section.erro}`).join("; ") || undefined;
      } catch (error) {
        result.erro = error instanceof Error ? error.message : String(error);
        result.alterado = false;
      }
      if (!dryRun) await write("/rest/v1/grupos_sincronizacoes", [{
        id: randomUUID(), nr_grupo: group, trigger_run_id: runId ?? null,
        status: result.status, iniciado_em: started, finalizado_em: new Date().toISOString(),
        resultado_secoes: result.secoes, erro: result.erro ?? null,
      }]);
      results.push(result);
      logger.log("Group sync progress", { ...result, processed: results.length, total: groups.length });
    }
  } finally {
    await client.logout().catch(() => undefined);
    await client.close();
  }
  return { workflow: "groups-sync", dryRun, groupCount: groups.length,
    successCount: results.filter((row) => row.status === "sucesso").length,
    partialCount: results.filter((row) => row.status === "parcial").length,
    errorCount: results.filter((row) => row.status === "falha").length,
    changedCount: results.filter((row) => row.alterado).length, results };
}
