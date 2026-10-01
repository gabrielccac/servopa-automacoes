import { parseSemicolonCsv } from "../csv.js";
import { parseInadimplentesPdf, type InadimplenteRecord } from "../pdf-parser.js";
import {
  supabaseRestDelete,
  supabaseRestGetAll,
  supabaseRestPatch,
  supabaseRestPost,
  quoteCsvValue,
} from "./client.js";

const BATCH_SIZE = 500;

interface ResultadoUltimasAssembleiasRow {
  dt_geracao: string | null;
  grupo: number | null;
  ass: number | null;
  segmento: string | null;
  dt_assemb: string | null;
  tp_lance: string | null;
  qt_contemp: number | null;
  pct_menor_lance_contemp: number | null;
  pct_media_lance_contemp: number | null;
  pct_maior_lance_contemp: number | null;
  qt_lances_ofertados: number | null;
  vlr_contemplado: number | null;
}

interface DisponivelParaVenderRow {
  dt_geracao: string | null;
  grupo: number | null;
  categ: string | null;
  prz_grp: number | null;
  ass: number | null;
  prz_vda: number | null;
  prox_ass: string | null;
  venc: number | null;
  pct_adm: number | null;
  pctfun_res: number | null;
  flex: string | null;
  vlr_bem: number | null;
  pct_mensal: number | null;
  vlr_parcela: number | null;
  vlr_seguro: number | null;
  vlr_parc_seg: number | null;
  seguro: string | null;
  segmento: string | null;
  qt_consorc: number | null;
  qt_vagas: number | null;
  pct_flexred: number | null;
  pct_sld_flex: number | null;
  pct_lance_emb: number | null;
  permite_furo: string | null;
  indice_correcao: string | null;
  periodo_correcao: string | null;
  dt_ult_reaj: string | null;
  dt_snapshot: string | null;
}

interface BdProducaoRow {
  nr_contrato: string;
  cd_whatsapp: string | null;
  dt_venda: string | null;
  dt_entrada: string | null;
  dt_ultimo_pagamento: string | null;
  dt_contemplacao: string | null;
  dt_cancelamento: string | null;
  dt_aliena: string | null;
  vl_credito: number | null;
  vl_parcela: number | null;
  vl_credito_contemplado: number | null;
  vl_seguro: number | null;
  tx_adm: number | null;
  tx_funres: number | null;
  tx_flex: number | null;
  nr_grupo: number | null;
  qt_prazo: number | null;
  qt_parcelas_pagas: number | null;
  qt_parcelas_antecipadas: number | null;
  qt_parcelas_emitidas: number | null;
  tp_pessoa: number | null;
  nr_cota: string | null;
  ds_situacao: string | null;
  ds_meio_pagamento: string | null;
  ds_segmento: string | null;
  ds_produto: string | null;
  st_contemplado: string | null;
  st_alienado: string | null;
  st_seguro: string | null;
  st_flex: string | null;
  nm_cpfcnpj_consorciado: string | null;
  nm_consorciado: string | null;
  cd_cel_consorciado: string | null;
  nm_email_consorciado: string | null;
  nm_uf_consorciado: string | null;
  nm_cpfcnpj_parceiro: string | null;
  nm_cpfcnpj_vendedor: string | null;
  nm_vendedor: string | null;
  nm_cpfcnpj_parceiro_comercial: string | null;
  nm_parceiro_comercial: string | null;
  ds_origem_da_venda: string | null;
  nr_diavenc: number | null;
}

export interface BdProducaoFieldSyncRow {
  nr_contrato: string;
  nr_grupo: number | null;
  gp_fidelidade: boolean | null;
  dt_cancelamento: string | null;
}

interface BdClientesRow {
  nm_cpfcnpj_consorciado: string;
  nm_consorciado: string | null;
  dt_nasc: string | null;
  cd_cel_consorciado: string | null;
  cd_fone_consorciado: string | null;
  nm_email_consorciado: string | null;
  dt_ultimo_venda: string | null;
  qt_cotas: number | null;
  dt_snapshot: string | null;
}

interface InadimplenteCycleRow extends InadimplenteRecord {
  id: string;
  cd_whatsapp: string | null;
  dt_primeira_ocorrencia: string;
  dt_ultima_ocorrencia: string;
  st_ativo: boolean;
}

interface BdProducaoPhoneRow {
  nr_contrato: string;
  cd_whatsapp: string | null;
}

interface InadimplenteDbRow {
  nr_cota: string;
  nr_contrato: string;
  nm_consorciado: string;
  cd_whatsapp: string | null;
  qt_pgo: number | null;
  qt_atr: number | null;
  vl_percent_mensal: number | null;
  vl_percent_difer: number | null;
  vl_atraso: number | null;
}

function chunkArray<T>(items: T[], size = BATCH_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function fetchBdProducaoPhonesByContract(
  contracts: string[],
): Promise<Map<string, string | null>> {
  const phonesByContract = new Map<string, string | null>();

  for (const chunk of chunkArray([...new Set(contracts.filter(Boolean))])) {
    const rows = await supabaseRestGetAll<BdProducaoPhoneRow>(
      `/rest/v1/bd_producao?select=nr_contrato,cd_whatsapp&nr_contrato=in.(${encodeURIComponent(
        chunk.map(quoteCsvValue).join(","),
      )})`,
    );

    for (const row of rows) {
      if (!phonesByContract.has(row.nr_contrato) || phonesByContract.get(row.nr_contrato) === null) {
        phonesByContract.set(row.nr_contrato, normalizeString(row.cd_whatsapp));
      }
    }
  }

  return phonesByContract;
}

function normalizeString(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function preserveOrBackfillWhatsapp(
  existingWhatsapp: string | null | undefined,
  sitePhone: string | null | undefined,
): string | null {
  return normalizeString(existingWhatsapp) ?? normalizeString(sitePhone);
}

function parseBrazilianDate(value: string | null | undefined): string | null {
  const normalized = normalizeString(value);
  if (!normalized) return null;

  const match = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;

  return `${match[3]}-${match[2]}-${match[1]}`;
}

function parseBrazilianNumber(value: string | null | undefined): number | null {
  const normalized = normalizeString(value);
  if (!normalized) return null;

  const cleaned = normalized
    .replace(/^R\$\s*/i, "")
    .replace(/\./g, "")
    .replace(",", ".");

  const parsed = Number.parseFloat(cleaned);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseInteger(value: string | null | undefined): number | null {
  const numeric = parseBrazilianNumber(value);
  return numeric === null ? null : Math.trunc(numeric);
}

function normalizeLegacyHeader(value: string): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/%/g, "pct")
    .replace(/[\s.]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+$/g, "");
}

function mapBdProducaoRows(csvText: string): BdProducaoRow[] {
  const rows = parseSemicolonCsv(csvText);

  return rows
    .map((row) => {
      const nrContrato = normalizeString(row["NR_CONTRATO"]);
      if (!nrContrato) {
        return null;
      }

      return {
        nr_contrato: nrContrato,
        cd_whatsapp: normalizeString(row["CD_WHATSAPP"] ?? null),
        dt_venda: parseBrazilianDate(row["DT_VENDA"]),
        dt_entrada: parseBrazilianDate(row["DT_ENTRADA"]),
        dt_ultimo_pagamento: parseBrazilianDate(row["DT_ULTIMO_PAGAMENTO"]),
        dt_contemplacao: parseBrazilianDate(row["DT_CONTEMPLACAO"]),
        dt_cancelamento: parseBrazilianDate(row["DT_CANCELAMENTO"]),
        dt_aliena: parseBrazilianDate(row["DT_ALIENA"]),
        vl_credito: parseBrazilianNumber(row["VL_CREDITO"]),
        vl_parcela: parseBrazilianNumber(row["VL_PARCELA"]),
        vl_credito_contemplado: parseBrazilianNumber(row["VL_CREDITO_CONTEMPLADO"]),
        vl_seguro: parseBrazilianNumber(row["VL_SEGURO"]),
        tx_adm: parseBrazilianNumber(row["TX_ADM"]),
        tx_funres: parseBrazilianNumber(row["TX_FUNRES"]),
        tx_flex: parseBrazilianNumber(row["TX_FLEX"]),
        nr_grupo: parseInteger(row["NR_GRUPO"]),
        qt_prazo: parseInteger(row["QT_PRAZO"]),
        qt_parcelas_pagas: parseInteger(row["QT_PARCELAS_PAGAS"]),
        qt_parcelas_antecipadas: parseInteger(row["QT_PARCELAS_ANTECIPADAS"]),
        qt_parcelas_emitidas: parseInteger(row["QT_PARCELAS_EMITIDAS"]),
        tp_pessoa: parseInteger(row["TP_PESSOA"]),
        nr_cota: normalizeString(row["NR_COTA"]),
        ds_situacao: normalizeString(row["DS_SITUACAO"]),
        ds_meio_pagamento: normalizeString(row["DS_MEIO_PAGAMENTO"]),
        ds_segmento: normalizeString(row["DS_SEGMENTO"]),
        ds_produto: normalizeString(row["DS_PRODUTO"]),
        st_contemplado: normalizeString(row["ST_CONTEMPLADO"]),
        st_alienado: normalizeString(row["ST_ALIENADO"]),
        st_seguro: normalizeString(row["ST_SEGURO"]),
        st_flex: normalizeString(row["ST_FLEX"]),
        nm_cpfcnpj_consorciado: normalizeString(row["NM_CPFCNPJ_CONSORCIADO"]),
        nm_consorciado: normalizeString(row["NM_CONSORCIADO"]),
        cd_cel_consorciado: normalizeString(row["CD_CEL_CONSORCIADO"]),
        nm_email_consorciado: normalizeString(row["NM_EMAIL_CONSORCIADO"]),
        nm_uf_consorciado: normalizeString(row["NM_UF_CONSORCIADO"]),
        nm_cpfcnpj_parceiro: normalizeString(row["NM_CPFCNPJ_PARCEIRO"]),
        nm_cpfcnpj_vendedor: normalizeString(row["NM_CPFCNPJ_VENDEDOR"]),
        nm_vendedor: normalizeString(row["NM_VENDEDOR"]),
        nm_cpfcnpj_parceiro_comercial: normalizeString(row["NM_CPFCNPJ_PARCEIRO_COMERCIAL"]),
        nm_parceiro_comercial: normalizeString(row["NM_PARCEIRO_COMERCIAL"]),
        ds_origem_da_venda: normalizeString(row["DS_ORIGEM_DA_VENDA"]),
        nr_diavenc: parseInteger(row["NR_DIAVENC"]),
      } satisfies BdProducaoRow;
    })
    .filter((row): row is BdProducaoRow => row !== null);
}

function mapBdClientesRows(csvText: string): BdClientesRow[] {
  const rows = parseSemicolonCsv(csvText);

  return rows
    .map((row) => {
      const normalizedRow = Object.fromEntries(
        Object.entries(row).map(([key, value]) => [normalizeLegacyHeader(key), value]),
      );
      const cpfCnpj = normalizeString(
        normalizedRow["nm_cpfcnpj_consorciado"] ??
          normalizedRow["cpfcnpj_consorciado"] ??
          normalizedRow["cpf_cnpj"] ??
          normalizedRow["cpfcnpj"] ??
          null,
      );
      if (!cpfCnpj) {
        return null;
      }

      const mappedRow: BdClientesRow = {
        nm_cpfcnpj_consorciado: cpfCnpj,
        nm_consorciado: normalizeString(normalizedRow["nm_consorciado"] ?? null),
        dt_nasc: parseBrazilianDate(
          normalizedRow["dt_nasc"] ??
            normalizedRow["dt_nascimento"] ??
            null,
        ),
        cd_cel_consorciado: normalizeString(
          normalizedRow["cd_cel_consorciado"] ??
            normalizedRow["cd_celular_consorciado"] ??
            null,
        ),
        cd_fone_consorciado: normalizeString(
          normalizedRow["cd_fone_consorciado"] ??
            normalizedRow["cd_fone_consorciado1"] ??
            null,
        ),
        nm_email_consorciado: normalizeString(
          normalizedRow["nm_email_consorciado"] ?? null,
        ),
        dt_ultimo_venda: parseBrazilianDate(
          normalizedRow["dt_ultimo_venda"] ??
            normalizedRow["dt_ultima_venda"] ??
            null,
        ),
        qt_cotas: parseInteger(normalizedRow["qt_cotas"] ?? null),
        dt_snapshot: null,
      };

      return mappedRow;
    })
    .filter((row): row is BdClientesRow => row !== null);
}

function mapResultadoUltimasAssembleiasRows(csvText: string): ResultadoUltimasAssembleiasRow[] {
  const rows = parseSemicolonCsv(csvText);

  return rows.map((row) => ({
    dt_geracao: parseBrazilianDate(row["DT GERACAO"]),
    grupo: parseInteger(row["GRUPO"]),
    ass: parseInteger(row["ASS"]),
    segmento: normalizeString(row["SEGMENTO"]),
    dt_assemb: parseBrazilianDate(row["DT ASSEMB"]),
    tp_lance: normalizeString(row["TP LANCE"]),
    qt_contemp: parseInteger(row["QT CONTEMP"]),
    pct_menor_lance_contemp: parseBrazilianNumber(row["% MENOR LANCE CONTEMP."]),
    pct_media_lance_contemp: parseBrazilianNumber(row["% MEDIA LANCE CONTEMP."]),
    pct_maior_lance_contemp: parseBrazilianNumber(row["% MAIOR LANCE CONTEMP."]),
    qt_lances_ofertados: parseInteger(row["QT LANCES OFERTADOS"]),
    vlr_contemplado: parseBrazilianNumber(row["VLR. CONTEMPLADO"]),
  }));
}

function mapDisponivelParaVenderRows(
  csvText: string,
  snapshotDate: string,
): DisponivelParaVenderRow[] {
  const rows = parseSemicolonCsv(csvText);

  return rows.map((row) => ({
    dt_geracao: parseBrazilianDate(row["DT GERACAO"]),
    grupo: parseInteger(row["GRUPO"]),
    categ: normalizeString(row["CATEG"]),
    prz_grp: parseInteger(row["PRZ GRP"]),
    ass: parseInteger(row["ASS"]),
    prz_vda: parseInteger(row["PRZ VDA"]),
    prox_ass: parseBrazilianDate(row["PROX ASS"]),
    venc: parseInteger(row["VENC"]),
    pct_adm: parseBrazilianNumber(row["% ADM"]),
    pctfun_res: parseBrazilianNumber(row["%FUN RES"]),
    flex: normalizeString(row["FLEX"]),
    vlr_bem: parseBrazilianNumber(row["VLR.BEM"]),
    pct_mensal: parseBrazilianNumber(row["% MENSAL"]),
    vlr_parcela: parseBrazilianNumber(row["VLR.PARCELA"]),
    vlr_seguro: parseBrazilianNumber(row["VLR.SEGURO"]),
    vlr_parc_seg: parseBrazilianNumber(row["VLR.PARC.SEG"]),
    seguro: normalizeString(row["SEGURO"]),
    segmento: normalizeString(row["SEGMENTO"]),
    qt_consorc: parseInteger(row["QT CONSORC"]),
    qt_vagas: parseInteger(row["QT VAGAS"]),
    pct_flexred: parseBrazilianNumber(row["% FLEX/RED"]),
    pct_sld_flex: parseBrazilianNumber(row["% SLD FLEX"]),
    pct_lance_emb: parseBrazilianNumber(row["% LANCE EMB"]),
    permite_furo: normalizeString(row["PERMITE FURO"]),
    indice_correcao: normalizeString(row["INDICE CORRECAO"]),
    periodo_correcao: normalizeString(row["PERIODO CORRECAO"]),
    dt_ult_reaj: parseBrazilianDate(row["DT.ULT.REAJ."]),
    dt_snapshot: snapshotDate,
  }));
}

async function upsertBdProducaoRows(rows: BdProducaoRow[]): Promise<void> {
  for (const chunk of chunkArray(rows)) {
    const response = await supabaseRestPost(
      "/rest/v1/bd_producao?on_conflict=nr_contrato",
      chunk,
      {
        headers: {
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to upsert bd_producao - HTTP ${response.status}: ${body}`);
    }
  }
}

async function upsertBdClientesRows(rows: BdClientesRow[]): Promise<void> {
  for (const chunk of chunkArray(rows)) {
    const response = await supabaseRestPost(
      "/rest/v1/bd_clientes?on_conflict=nm_cpfcnpj_consorciado",
      chunk,
      {
        headers: {
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to upsert bd_clientes - HTTP ${response.status}: ${body}`);
    }
  }
}

async function upsertResultadoUltimasAssembleiasRows(
  rows: ResultadoUltimasAssembleiasRow[],
): Promise<void> {
  for (const chunk of chunkArray(rows)) {
    const response = await supabaseRestPost(
      "/rest/v1/resultado_ultimas_assembleias",
      chunk,
      {
        headers: {
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to merge resultado_ultimas_assembleias rows - HTTP ${response.status}`,
      );
    }
  }
}

async function replaceDisponivelParaVenderRows(
  rows: DisponivelParaVenderRow[],
): Promise<void> {
  const snapshotDate = rows[0]?.dt_snapshot ?? null;

  for (const chunk of chunkArray(rows)) {
    const insertResponse = await supabaseRestPost(
      "/rest/v1/disponivel_para_vender",
      chunk,
      {
        headers: {
          Prefer: "return=minimal",
        },
      },
    );

    if (!insertResponse.ok) {
      throw new Error(
        `Failed to insert disponivel_para_vender rows - HTTP ${insertResponse.status}`,
      );
    }
  }

  if (!snapshotDate) {
    return;
  }

  const deleteResponse = await supabaseRestDelete(
    `/rest/v1/disponivel_para_vender?dt_snapshot=neq.${encodeURIComponent(snapshotDate)}`,
    {
      headers: {
        Prefer: "return=minimal",
      },
    },
  );

  if (!deleteResponse.ok) {
    throw new Error(
      `Failed to prune previous disponivel_para_vender snapshots - HTTP ${deleteResponse.status}`,
    );
  }
}

export async function syncBdProducaoCsv(csvText: string): Promise<{
  rowCount: number;
  contracts: string[];
}> {
  const rows = mapBdProducaoRows(csvText);
  const existingPhones = await fetchBdProducaoPhonesByContract(
    rows.map((row) => row.nr_contrato),
  );
  const rowsWithWhatsapp = rows.map((row) => ({
    ...row,
    cd_whatsapp: preserveOrBackfillWhatsapp(
      existingPhones.get(row.nr_contrato),
      row.cd_cel_consorciado,
    ),
  }));
  await upsertBdProducaoRows(rowsWithWhatsapp);

  return {
    rowCount: rows.length,
    contracts: rows.map((row) => row.nr_contrato),
  };
}

export async function syncBdClientesCsv(
  csvText: string,
  snapshotDate: string,
): Promise<{
  rowCount: number;
}> {
  const rows = mapBdClientesRows(csvText).map((row) => ({
    ...row,
    dt_snapshot: snapshotDate,
  }));
  await upsertBdClientesRows(rows);

  return {
    rowCount: rows.length,
  };
}

export async function syncResultadoUltimasAssembleiasCsv(csvText: string): Promise<{
  rowCount: number;
}> {
  const rows = mapResultadoUltimasAssembleiasRows(csvText);
  await upsertResultadoUltimasAssembleiasRows(rows);

  return {
    rowCount: rows.length,
  };
}

export async function syncDisponivelParaVenderCsv(
  csvText: string,
  snapshotDate: string,
): Promise<{
  rowCount: number;
}> {
  const rows = mapDisponivelParaVenderRows(csvText, snapshotDate);
  await replaceDisponivelParaVenderRows(rows);

  return {
    rowCount: rows.length,
  };
}

export async function syncInadimplentesPdf(
  pdfBuffer: Buffer,
  todayIsoDate: string,
): Promise<{
  rowCount: number;
  insertedCount: number;
  updatedCount: number;
  closedCount: number;
}> {
  const parsedRows = await parseInadimplentesPdf(pdfBuffer);
  const phonesByContract = await fetchBdProducaoPhonesByContract(
    parsedRows.map((row) => row.nr_contrato),
  );
  const activeRows = await supabaseRestGetAll<InadimplenteCycleRow>(
    "/rest/v1/inadimplentes?select=id,nr_contrato,cd_whatsapp,dt_primeira_ocorrencia,dt_ultima_ocorrencia,st_ativo&st_ativo=is.true",
  );
  const activeByContract = new Map(
    activeRows.map((row) => [row.nr_contrato, row]),
  );

  const currentContracts = new Set(parsedRows.map((row) => row.nr_contrato));
  const rowsToInsert: Array<
    InadimplenteDbRow & {
      dt_primeira_ocorrencia: string;
      dt_ultima_ocorrencia: string;
      st_ativo: boolean;
    }
  > = [];

  let updatedCount = 0;

  for (const row of parsedRows) {
    const existingActiveRow = activeByContract.get(row.nr_contrato);
    const cdWhatsapp =
      phonesByContract.get(row.nr_contrato) ??
      normalizeString(existingActiveRow?.cd_whatsapp) ??
      null;
    const rowForDb = {
      nr_cota: row.nr_cota,
      nr_contrato: row.nr_contrato,
      nm_consorciado: row.nm_consorciado,
      cd_whatsapp: cdWhatsapp,
      qt_pgo: row.qt_pgo,
      qt_atr: row.qt_atr,
      vl_percent_mensal: row.vl_percent_mensal,
      vl_percent_difer: row.vl_percent_difer,
      vl_atraso: row.vl_atraso,
    };

    if (existingActiveRow) {
      const patchResponse = await supabaseRestPatch(
        `/rest/v1/inadimplentes?id=eq.${existingActiveRow.id}`,
        {
          ...rowForDb,
          dt_ultima_ocorrencia: todayIsoDate,
          st_ativo: true,
        },
        {
          headers: {
            Prefer: "return=minimal",
          },
        },
      );

      if (!patchResponse.ok) {
        throw new Error(
          `Failed to update inadimplente cycle ${existingActiveRow.id} - HTTP ${patchResponse.status}`,
        );
      }

      updatedCount += 1;
    } else {
      rowsToInsert.push({
        ...rowForDb,
        dt_primeira_ocorrencia: todayIsoDate,
        dt_ultima_ocorrencia: todayIsoDate,
        st_ativo: true,
      });
    }
  }

  for (const chunk of chunkArray(rowsToInsert)) {
    const insertResponse = await supabaseRestPost(
      "/rest/v1/inadimplentes",
      chunk,
      {
        headers: {
          Prefer: "return=minimal",
        },
      },
    );

    if (!insertResponse.ok) {
      throw new Error(`Failed to insert inadimplentes rows - HTTP ${insertResponse.status}`);
    }
  }

  const rowsToClose = activeRows.filter((row) => !currentContracts.has(row.nr_contrato));
  const idsToClose = rowsToClose.map((row) => row.id);

  for (const chunk of chunkArray(idsToClose)) {
    const patchResponse = await supabaseRestPatch(
      `/rest/v1/inadimplentes?id=in.(${encodeURIComponent(
        chunk.map(quoteCsvValue).join(","),
      )})`,
      {
        st_ativo: false,
      },
      {
        headers: {
          Prefer: "return=minimal",
        },
      },
    );

    if (!patchResponse.ok) {
      throw new Error(`Failed to close inactive inadimplentes rows - HTTP ${patchResponse.status}`);
    }
  }

  return {
    rowCount: parsedRows.length,
    insertedCount: rowsToInsert.length,
    updatedCount,
    closedCount: rowsToClose.length,
  };
}

export async function fetchBdProducaoRowsForFidelidadeSync(options?: {
  contracts?: string[];
}): Promise<BdProducaoFieldSyncRow[]> {
  const filters = [
    "select=nr_contrato,nr_grupo,gp_fidelidade,dt_cancelamento",
    "dt_cancelamento=is.null",
  ];

  if (options?.contracts?.length) {
    const uniqueContracts = [...new Set(options.contracts.map((contract) => contract.trim()).filter(Boolean))];
    if (uniqueContracts.length === 0) {
      return [];
    }

    filters.push(`nr_contrato=in.(${encodeURIComponent(uniqueContracts.map(quoteCsvValue).join(","))})`);
  }

  return supabaseRestGetAll<BdProducaoFieldSyncRow>(`/rest/v1/bd_producao?${filters.join("&")}`);
}

export async function syncBdProducaoFidelidadeFields(options?: {
  contracts?: string[];
}): Promise<{
  updatedTrueCount: number;
  updatedFalseCount: number;
}> {
  const rows = await fetchBdProducaoRowsForFidelidadeSync(options);
  const rowsToUpdate = rows.filter((row) => row.gp_fidelidade === null);

  if (rowsToUpdate.length === 0) {
    return {
      updatedTrueCount: 0,
      updatedFalseCount: 0,
    };
  }

  const fidelidadeRows = await supabaseRestGetAll<{
    grupo: number | null;
  }>("/rest/v1/resultado_ultimas_assembleias?select=grupo&tp_lance=eq.FIDELIDADE");
  const fidelidadeGroups = new Set(
    fidelidadeRows
      .map((row) => row.grupo)
      .filter((grupo): grupo is number => grupo !== null),
  );

  const rowsToSetTrue = rowsToUpdate
    .filter((row) => row.nr_grupo !== null && fidelidadeGroups.has(row.nr_grupo))
    .map((row) => ({
      nr_contrato: row.nr_contrato,
      gp_fidelidade: true,
    }));
  const rowsToSetFalse = rowsToUpdate
    .filter((row) => row.nr_grupo === null || !fidelidadeGroups.has(row.nr_grupo))
    .map((row) => ({
      nr_contrato: row.nr_contrato,
      gp_fidelidade: false,
    }));

  for (const chunk of chunkArray([...rowsToSetTrue, ...rowsToSetFalse])) {
    const response = await supabaseRestPost(
      "/rest/v1/bd_producao?on_conflict=nr_contrato",
      chunk,
      {
        headers: {
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to sync gp_fidelidade - HTTP ${response.status}: ${body}`);
    }
  }

  return {
    updatedTrueCount: rowsToSetTrue.length,
    updatedFalseCount: rowsToSetFalse.length,
  };
}
