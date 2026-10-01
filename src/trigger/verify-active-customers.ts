import { logger, task } from "@trigger.dev/sdk";
import { altSupabaseRestGetAll, altSupabaseRestPatch } from "../lib/supabase/client.js";
import { parseAsOfDate } from "../lib/reminders/shared.js";

interface AltCustomerRow {
  cpf: string | null;
  nome_completo: string | null;
  status: string | null;
}

interface InvestmentContractRow {
  cpf: string | null;
  nome_completo: string | null;
  data_contrato: string | null;
  data_vencimento: string | null;
}

interface GenericContractRow {
  cpf: string | null;
  nome_completo: string | null;
  tipo_contrato?: string | null;
  data_contrato?: string | null;
  previsao_termino?: string | null;
  prazo_contrato?: string | null;
  prazo_contrato_tipo?: string | null;
}

interface ActiveEvidence {
  cpf: string;
  nome_completo: string | null;
  table: string;
  rule:
    | "explicit_contrato_ativo_true"
    | "previsao_termino"
    | "data_contrato_plus_prazo_contrato";
  data_contrato: string | null;
  previsao_termino: string | null;
  prazo_contrato: string | null;
  prazo_contrato_tipo: string | null;
  inferred_end_date: string | null;
}

interface IgnoredRow {
  cpf: string;
  nome_completo: string | null;
  table: string;
  reason:
    | "missing_cpf"
    | "no_reliable_rule_for_table"
    | "missing_required_duration_fields"
    | "invalid_or_unparseable_date_fields"
    | "expired_by_rule";
  data_contrato: string | null;
  previsao_termino: string | null;
  prazo_contrato: string | null;
  prazo_contrato_tipo: string | null;
}

function cleanText(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeCpf(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D/g, "");
}

function parseFlexibleDate(value: string | null | undefined): Date | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (isoMatch) {
    const [, yearRaw, monthRaw, dayRaw] = isoMatch;
    const year = Number.parseInt(yearRaw, 10);
    const month = Number.parseInt(monthRaw, 10);
    const day = Number.parseInt(dayRaw, 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return new Date(Date.UTC(year, month - 1, day));
  }

  const brMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (brMatch) {
    const [, dayRaw, monthRaw, yearRaw] = brMatch;
    const year = Number.parseInt(yearRaw, 10);
    const month = Number.parseInt(monthRaw, 10);
    const day = Number.parseInt(dayRaw, 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return new Date(Date.UTC(year, month - 1, day));
  }

  return null;
}

function dateToIso(date: Date | null): string | null {
  if (!date) return null;
  return date.toISOString().slice(0, 10);
}

function getTodayInSaoPaulo(asOfDate?: string): Date {
  if (asOfDate) return new Date(`${asOfDate}T12:00:00.000Z`);

  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value ?? "1970");
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "01");
  const day = Number(parts.find((part) => part.type === "day")?.value ?? "01");
  return new Date(Date.UTC(year, month - 1, day));
}

function addMonths(date: Date, months: number): Date {
  const clone = new Date(date.getTime());
  const year = clone.getUTCFullYear();
  const month = clone.getUTCMonth();
  const day = clone.getUTCDate();
  const target = new Date(Date.UTC(year, month + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

function parseDurationMonths(
  prazoContrato: string | null | undefined,
  prazoContratoTipo: string | null | undefined,
): number | null {
  const prazoRaw = String(prazoContrato ?? "").trim();
  const tipoRaw = String(prazoContratoTipo ?? "").trim().toLowerCase();
  const combinedRaw = [prazoRaw, String(prazoContratoTipo ?? "").trim()].filter(Boolean).join(" ");
  const combinedLower = combinedRaw.toLowerCase();
  if (!combinedRaw) return null;
  if (combinedLower.includes("indeterminado")) return null;

  const digitsMatch = combinedRaw.match(/\d+/);
  if (!digitsMatch) return null;

  const value = Number.parseInt(digitsMatch[0], 10);
  if (Number.isNaN(value) || value <= 0) return null;

  const prazoLower = prazoRaw.toLowerCase();
  if (
    prazoLower.includes("mes") ||
    tipoRaw.includes("mes") ||
    combinedLower.includes("mes")
  ) {
    return value;
  }

  if (
    prazoLower.includes("ano") ||
    tipoRaw.includes("ano") ||
    combinedLower.includes("ano")
  ) {
    return value * 12;
  }

  if (/^\d+$/.test(prazoRaw)) {
    return value;
  }

  return null;
}

function isDateOnOrAfter(date: Date, threshold: Date): boolean {
  return date.getTime() >= threshold.getTime();
}

function pushEvidence(
  activeByCpf: Map<string, ActiveEvidence[]>,
  evidence: ActiveEvidence,
): void {
  const existing = activeByCpf.get(evidence.cpf) ?? [];
  existing.push(evidence);
  activeByCpf.set(evidence.cpf, existing);
}

function evaluateDateDrivenRow(
  table: string,
  row: GenericContractRow,
  today: Date,
): { evidence?: ActiveEvidence; ignored?: IgnoredRow } {
  const cpf = normalizeCpf(row.cpf);
  if (!cpf) {
    return {
      ignored: {
        cpf: "",
        nome_completo: cleanText(row.nome_completo),
        table,
        reason: "missing_cpf",
        data_contrato: cleanText(row.data_contrato),
        previsao_termino: cleanText(row.previsao_termino),
        prazo_contrato: cleanText(row.prazo_contrato),
        prazo_contrato_tipo: cleanText(row.prazo_contrato_tipo),
      },
    };
  }

  const previsaoTermino = parseFlexibleDate(row.previsao_termino);
  if (row.previsao_termino && !previsaoTermino) {
    return {
      ignored: {
        cpf,
        nome_completo: cleanText(row.nome_completo),
        table,
        reason: "invalid_or_unparseable_date_fields",
        data_contrato: cleanText(row.data_contrato),
        previsao_termino: cleanText(row.previsao_termino),
        prazo_contrato: cleanText(row.prazo_contrato),
        prazo_contrato_tipo: cleanText(row.prazo_contrato_tipo),
      },
    };
  }

  if (previsaoTermino) {
    if (isDateOnOrAfter(previsaoTermino, today)) {
      return {
        evidence: {
          cpf,
          nome_completo: cleanText(row.nome_completo),
          table,
          rule: "previsao_termino",
          data_contrato: cleanText(row.data_contrato),
          previsao_termino: cleanText(row.previsao_termino),
          prazo_contrato: cleanText(row.prazo_contrato),
          prazo_contrato_tipo: cleanText(row.prazo_contrato_tipo),
          inferred_end_date: dateToIso(previsaoTermino),
        },
      };
    }

    return {
      ignored: {
        cpf,
        nome_completo: cleanText(row.nome_completo),
        table,
        reason: "expired_by_rule",
        data_contrato: cleanText(row.data_contrato),
        previsao_termino: cleanText(row.previsao_termino),
        prazo_contrato: cleanText(row.prazo_contrato),
        prazo_contrato_tipo: cleanText(row.prazo_contrato_tipo),
      },
    };
  }

  const startDate = parseFlexibleDate(row.data_contrato);
  const durationMonths = parseDurationMonths(row.prazo_contrato, row.prazo_contrato_tipo);
  if (!startDate || durationMonths === null) {
    return {
      ignored: {
        cpf,
        nome_completo: cleanText(row.nome_completo),
        table,
        reason: "missing_required_duration_fields",
        data_contrato: cleanText(row.data_contrato),
        previsao_termino: cleanText(row.previsao_termino),
        prazo_contrato: cleanText(row.prazo_contrato),
        prazo_contrato_tipo: cleanText(row.prazo_contrato_tipo),
      },
    };
  }

  const endDate = addMonths(startDate, durationMonths);
  if (!isDateOnOrAfter(endDate, today)) {
    return {
      ignored: {
        cpf,
        nome_completo: cleanText(row.nome_completo),
        table,
        reason: "expired_by_rule",
        data_contrato: cleanText(row.data_contrato),
        previsao_termino: cleanText(row.previsao_termino),
        prazo_contrato: cleanText(row.prazo_contrato),
        prazo_contrato_tipo: cleanText(row.prazo_contrato_tipo),
      },
    };
  }

  return {
    evidence: {
      cpf,
      nome_completo: cleanText(row.nome_completo),
      table,
      rule: "data_contrato_plus_prazo_contrato",
      data_contrato: cleanText(row.data_contrato),
      previsao_termino: cleanText(row.previsao_termino),
      prazo_contrato: cleanText(row.prazo_contrato),
      prazo_contrato_tipo: cleanText(row.prazo_contrato_tipo),
      inferred_end_date: dateToIso(endDate),
    },
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export const verifyActiveCustomers = task({
  id: "verify-active-customers",
  maxDuration: 900,
  queue: { concurrencyLimit: 1 },
  run: async (payload: unknown) => {
    const input =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { dryRun?: boolean; verbose?: boolean; asOfDate?: unknown })
        : null;
    const dryRun = input?.dryRun ?? false;
    const verbose = input?.verbose ?? false;
    const asOfDate = parseAsOfDate(input?.asOfDate);
    const today = getTodayInSaoPaulo(asOfDate ?? undefined);

    const [
      clientesRows,
      investmentRows,
      consultoriaRows,
      mentoriaRows,
      contratosServicosRows,
      contratosTituloPrivadoRows,
    ] = await Promise.all([
      altSupabaseRestGetAll<AltCustomerRow>("/rest/v1/clientes?select=cpf,nome_completo,status"),
      altSupabaseRestGetAll<InvestmentContractRow>(
        "/rest/v1/assinados_investimento?select=cpf,nome_completo,data_contrato,data_vencimento",
      ),
      altSupabaseRestGetAll<GenericContractRow>("/rest/v1/consultoria?select=*"),
      altSupabaseRestGetAll<GenericContractRow>("/rest/v1/mentoria?select=*"),
      altSupabaseRestGetAll<GenericContractRow>("/rest/v1/contratos_servicos?select=*"),
      altSupabaseRestGetAll<GenericContractRow>("/rest/v1/contratos_Titulo-Privado?select=*"),
    ]);

    const activeByCpf = new Map<string, ActiveEvidence[]>();
    const ignoredRows: IgnoredRow[] = [];

    const investmentContractRows: GenericContractRow[] = investmentRows.map((row) => ({
      cpf: row.cpf,
      nome_completo: row.nome_completo,
      data_contrato: row.data_contrato,
      previsao_termino: row.data_vencimento,
    }));

    for (const [table, rows] of [
      ["assinados_investimento", investmentContractRows],
      ["consultoria", consultoriaRows],
      ["mentoria", mentoriaRows],
      ["contratos_servicos", contratosServicosRows],
      [
        "contratos_Titulo-Privado",
        contratosTituloPrivadoRows.filter((row) => Boolean(cleanText(row.previsao_termino))),
      ],
    ] as const) {
      for (const row of rows) {
        const evaluation = evaluateDateDrivenRow(table, row, today);
        if (evaluation.evidence) {
          pushEvidence(activeByCpf, evaluation.evidence);
        } else if (evaluation.ignored) {
          ignoredRows.push(evaluation.ignored);
        }
      }
    }

    const clientesByCpf = new Map(
      clientesRows
        .map((row) => {
          const cpf = normalizeCpf(row.cpf);
          return cpf ? [cpf, row] as const : null;
        })
        .filter((entry): entry is readonly [string, AltCustomerRow] => Boolean(entry)),
    );

    const verifiedActiveCustomers = [...activeByCpf.entries()]
      .map(([cpf, evidence]) => ({
        cpf,
        nome_completo:
          evidence.find((item) => cleanText(item.nome_completo))?.nome_completo ??
          clientesByCpf.get(cpf)?.nome_completo ??
          null,
        origens: uniqueStrings(evidence.map((item) => item.table)),
        evidence,
      }))
      .sort((a, b) => a.cpf.localeCompare(b.cpf));

    const verifiedActiveCpfSet = new Set(verifiedActiveCustomers.map((row) => row.cpf));

    const currentClientes = [...clientesByCpf.entries()].map(([cpf, row]) => ({
      cpf,
      nome_completo: cleanText(row.nome_completo),
      status: cleanText(row.status),
    }));

    const customersToActivate = currentClientes
      .filter((row) => verifiedActiveCpfSet.has(row.cpf))
      .filter((row) => row.status !== "ativo")
      .map((row) => ({
        cpf: row.cpf,
        nome_completo: row.nome_completo,
        fromStatus: row.status,
        toStatus: "ativo" as const,
        evidence: activeByCpf.get(row.cpf) ?? [],
      }))
      .sort((a, b) => a.cpf.localeCompare(b.cpf));

    const customersToInactivate = currentClientes
      .filter((row) => !verifiedActiveCpfSet.has(row.cpf))
      .filter((row) => row.status !== "inativo")
      .map((row) => ({
        cpf: row.cpf,
        nome_completo: row.nome_completo,
        fromStatus: row.status,
        toStatus: "inativo" as const,
        reason: "no_reliable_active_evidence_found",
      }))
      .sort((a, b) => a.cpf.localeCompare(b.cpf));

    const inactivationGuardTriggered =
      (currentClientes.length > 0 && verifiedActiveCustomers.length === 0) ||
      customersToInactivate.length >
        Math.max(100, Math.ceil(currentClientes.length * 0.5));

    if (!dryRun && inactivationGuardTriggered) {
      throw new Error(
        `Refusing mass customer inactivation: ${customersToInactivate.length} of ` +
          `${currentClientes.length} customers would be changed`,
      );
    }

    if (!dryRun) {
      for (const row of customersToActivate) {
        const rawCpf = clientesByCpf.get(row.cpf)?.cpf;
        if (!rawCpf) continue;

        const response = await altSupabaseRestPatch(
          `/rest/v1/clientes?cpf=eq.${encodeURIComponent(rawCpf)}`,
          { status: "ativo" },
        );

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Failed to activate cliente ${row.cpf} - HTTP ${response.status}: ${body}`);
        }
      }

      for (const row of customersToInactivate) {
        const rawCpf = clientesByCpf.get(row.cpf)?.cpf;
        if (!rawCpf) continue;

        const response = await altSupabaseRestPatch(
          `/rest/v1/clientes?cpf=eq.${encodeURIComponent(rawCpf)}`,
          { status: "inativo" },
        );

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Failed to inactivate cliente ${row.cpf} - HTTP ${response.status}: ${body}`);
        }
      }
    }

    const ignoredByTable = ignoredRows.reduce<Record<string, number>>((acc, row) => {
      acc[row.table] = (acc[row.table] ?? 0) + 1;
      return acc;
    }, {});

    logger.log("Verify active customers summary", {
      dryRun,
      verbose,
      currentClientesCount: currentClientes.length,
      verifiedActiveCount: verifiedActiveCustomers.length,
      customersToActivateCount: customersToActivate.length,
      customersToInactivateCount: customersToInactivate.length,
      inactivationGuardTriggered,
      ignoredCount: ignoredRows.length,
      ignoredByTable,
    });

    return {
      workflow: "verify-active-customers",
      mode: dryRun ? "dry-run" : "apply",
      verbose,
      evaluatedSources: [
        "assinados_investimento",
        "consultoria",
        "mentoria",
        "contratos_servicos",
        "contratos_Titulo-Privado",
      ],
      ignoredSources: [
        "contratos_diversos",
        "contratos_estagio-Parceria",
        "contratos_cessao_Credito",
        "contratos_inativos",
      ],
      summary: {
        currentClientesCount: currentClientes.length,
        verifiedActiveCount: verifiedActiveCustomers.length,
        customersToActivateCount: customersToActivate.length,
        customersToInactivateCount: customersToInactivate.length,
        inactivationGuardTriggered,
        ignoredCount: ignoredRows.length,
        ignoredByTable,
      },
      samples: {
        customersToActivate: customersToActivate.slice(0, 10),
        customersToInactivate: customersToInactivate.slice(0, 10),
        ignoredRows: ignoredRows.slice(0, 10),
      },
      ...(verbose
        ? {
            verifiedActiveCustomers,
            customersToActivate,
            customersToInactivate,
            ignoredRows,
          }
        : {}),
    };
  },
});
