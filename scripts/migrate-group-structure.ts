import fs from "node:fs";
import assert from "node:assert/strict";
import { getSupabaseBaseUrl, supabaseRestGetAll, supabaseRestPatch, supabaseRestGet } from "../src/lib/supabase/client.js";
import { parseGroupAssemblyRules, validateGroupAssemblyRules } from "../src/lib/servopa/group-rules.js";
import type { GroupAdministrationRate } from "../src/lib/servopa/groups.js";

// One-time backfill before switching offer-reminder away from regras_texto. No DDL or deletions.
async function main() {
  if (new URL(getSupabaseBaseUrl()).hostname !== "umvldqzzliqmgkvoedyd.supabase.co") throw Error("Unexpected Supabase project");
  const apply = process.argv.includes("--apply");
  if (process.argv.slice(2).some((arg) => arg !== "--apply")) throw Error("Only --apply is supported; default is read-only");
  const rows = await supabaseRestGetAll<Record<string, unknown>>("/rest/v1/grupos?select=*&order=nr_grupo");
  const converted = rows.map((row) => {
    const nr_grupo = Number(row.nr_grupo);
    if (!Number.isSafeInteger(nr_grupo) || nr_grupo < 1) throw Error("Invalid group identifier");
    if (typeof row.regras_texto !== "string" || !Array.isArray(row.planos) || !row.planos.length) {
      throw Error(`Group ${nr_grupo}: legacy rules/plans unavailable; use groups-sync after migration`);
    }
    const taxas_administracao: GroupAdministrationRate[] = row.planos.map((plan) => {
      if (!plan || typeof plan !== "object") throw Error(`Group ${nr_grupo}: invalid legacy plan`);
      const p = plan as Record<string, unknown>;
      for (const key of ["categoria", "descricao"]) if (typeof p[key] !== "string" || !p[key]) throw Error(`Group ${nr_grupo}: missing ${key}`);
      for (const key of ["taxa_administracao", "prazo_meses", "prazo_original_meses", "valor_credito"]) {
        if (typeof p[key] !== "number" || !Number.isFinite(p[key]) || p[key] < 0) throw Error(`Group ${nr_grupo}: invalid ${key}`);
      }
      if (Number(p.taxa_administracao) > 100 || !Number.isSafeInteger(p.prazo_meses) ||
        !Number.isSafeInteger(p.prazo_original_meses) || Number(p.prazo_meses) < 1 || Number(p.prazo_original_meses) < 1) {
        throw Error(`Group ${nr_grupo}: invalid legacy rate conditions`);
      }
      return { categoria: String(p.categoria), descricao: String(p.descricao), percentual: Number(p.taxa_administracao),
        prazo_meses: Number(p.prazo_meses), prazo_original_meses: Number(p.prazo_original_meses), valor_credito: Number(p.valor_credito) };
    });
    return { nr_grupo, regras_assembleias: validateGroupAssemblyRules(parseGroupAssemblyRules(row.regras_texto)), taxas_administracao };
  });
  if (apply) {
    const check = await supabaseRestGet("/rest/v1/grupos?select=nr_grupo,regras_assembleias,taxas_administracao&limit=0");
    if (!check.ok) throw Error("Apply sql/002_grupos_estruturados.sql before backfill");
    fs.mkdirSync(".local", { recursive: true });
    const backup = `.local/grupos-before-structured-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    fs.writeFileSync(backup, JSON.stringify(rows, null, 2), { flag: "wx" });
    console.log(JSON.stringify({ backup }));
    for (const { nr_grupo, ...data } of converted) {
      const response = await supabaseRestPatch(`/rest/v1/grupos?nr_grupo=eq.${nr_grupo}`, data, { headers: { Prefer: "return=representation" } });
      if (!response.ok) throw Error(`Backfill group ${nr_grupo} failed - HTTP ${response.status}`);
      const saved = await response.json() as Record<string, unknown>[];
      assert.equal(saved.length, 1, `Backfill group ${nr_grupo} not confirmed`);
      assert.deepEqual(saved[0].regras_assembleias, data.regras_assembleias);
      assert.deepEqual(saved[0].taxas_administracao, data.taxas_administracao);
      validateGroupAssemblyRules(saved[0].regras_assembleias);
    }
  }
  console.log(JSON.stringify({ mode: apply ? "applied" : "read-only", groups: converted.length,
    phases: converted.reduce((n, row) => n + row.regras_assembleias.length, 0),
    rateConditions: converted.reduce((n, row) => n + row.taxas_administracao.length, 0),
    retiredColumnsDeleted: false }));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Group backfill failed"); process.exitCode = 1; });
