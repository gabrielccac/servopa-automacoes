import { load, type CheerioAPI } from "cheerio";
import type { Element } from "domhandler";

export type GroupMode = "sem_embutido" | "com_embutido";
export interface GroupPlan {
  categoria: string;
  descricao: string;
  taxa_administracao: number;
  prazo_meses: number;
  prazo_original_meses: number;
  valor_credito: number;
  percentual_mensal: number;
  parcela_sem_seguro: number;
  seguro: number;
  observacao: string;
  parcela_total: number;
  disponivel?: boolean;
  ultima_visualizacao_em?: string;
}
export interface GroupAssembly {
  numero: number;
  data: string;
  horario: string;
  local: string;
  cidade: string;
  situacao: string;
}
export interface GroupBidHistory {
  assembleia_numero: number;
  data: string;
  modalidade: GroupMode;
  maior_lance: number;
  menor_lance: number;
  quantidade: number;
}
export type GroupSection<T> = { status: "ok"; data: T } |
  { status: "falha"; erro: string } | { status: "sem_historico" };

function text(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function normalized(value: string): string {
  return text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
export function groupNumber(value: string): number {
  const raw = value.replace(/^R\$\s*/, "").replace(/%$/, "").trim();
  if (!/^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/.test(raw)) {
    throw new Error(`Invalid group numeric value: ${value}`);
  }
  return Number(raw.replace(/\./g, "").replace(",", "."));
}
function integer(value: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const result = groupNumber(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error("Invalid group integer");
  return result;
}
function percent(value: string): number {
  const result = groupNumber(value);
  if (result > 100) throw new Error("Group percentage exceeds 100");
  return result;
}
function date(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/.exec(value);
  if (!match) throw new Error(`Invalid group date: ${value}`);
  const iso = `${match[3].length === 2 ? "20" : ""}${match[3]}-${match[2]}-${match[1]}`;
  const parsed = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) throw new Error("Invalid group calendar date");
  return iso;
}
function dateTime(value: string) {
  const match = /^(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}:\d{2})(?:h|\s+HORAS)$/i.exec(value);
  if (!match || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(match[2])) throw new Error("Invalid group date/time");
  return { data: date(match[1]), horario: match[2] };
}
function tableWithHeaders($: CheerioAPI, expected: string[]): Element[] {
  return $("table").toArray().filter((table) => {
    const actual = $(table).find("thead th").map((_, e) => normalized($(e).text())).get().filter(Boolean);
    return JSON.stringify(actual) === JSON.stringify(expected.map(normalized));
  });
}
function rows($: CheerioAPI, table: Element, width: number): { cells: string[]; element: Element }[] {
  return $(table).find("tbody tr").toArray().map((element) => {
    const cells = $(element).children("td").map((_, e) => text($(e).text())).get();
    if (cells.length !== width || cells.some((_, i) => $(element).children("td").eq(i).attr("colspan"))) {
      throw new Error("Unexpected group table row layout");
    }
    return { cells, element };
  });
}
function unique<T>(items: T[], key: (item: T) => string): T[] {
  if (new Set(items.map(key)).size !== items.length) throw new Error("Duplicate group records in source");
  return items;
}
export function groupPlanKey(plan: GroupPlan): string {
  return `${plan.categoria}:${plan.taxa_administracao}:${plan.prazo_original_meses}`;
}
export function captureGroupSection<T>(read: () => T): GroupSection<T> {
  try { return { status: "ok", data: read() }; }
  catch (error) { return { status: "falha", erro: error instanceof Error ? error.message : String(error) }; }
}
export function assertGroupPage(html: string, group: number): void {
  const $ = load(html);
  const headings = $("h3").map((_, e) => text($(e).text())).get();
  if (!headings.includes(`Informações do Grupo: ${group}`)) throw new Error(`Could not confirm group ${group} in portal response`);
}
export function parseGroupListing(html: string, group: number) {
  const $ = load(html);
  const tables = tableWithHeaders($, ["Grupo", "Segmento", "Meses", "Assembléia", "Lance", "Contemplados", "Vagas", "Visualizar"]);
  if (tables.length !== 1) throw new Error(`Group ${group} search did not return a recognized listing`);
  const matches = rows($, tables[0], 8).filter(({ cells }) => integer(cells[0], 1) === group);
  if (matches.length !== 1) throw new Error(`Group ${group} was not uniquely found in commercial listing`);
  const c = matches[0].cells;
  if (c[1] !== "M" && c[1] !== "I") throw new Error("Unknown group segment");
  return { segmento: c[1], prazo_total_meses: integer(c[2], 1), vagas_disponiveis: integer(c[6]), disponivel: true };
}
function parseCharacteristics($: CheerioAPI) {
  const fields = new Map<string, string>();
  $("table").filter((_, e) => !$(e).find("th").length).find("tr").each((_, row) => {
    const cells = $(row).children("td");
    if (cells.length === 2) fields.set(normalized(cells.eq(0).text()).replace(/:$/, ""), text(cells.eq(1).text()));
  });
  function field(label: string) {
    const value = fields.get(normalized(label));
    if (!value) throw new Error(`Missing group field: ${label}`);
    return value;
  }
  const next = /^(\d+)\s*-\s*(.+)$/.exec(field("Próxima assembléia"));
  if (!next) throw new Error("Invalid next group assembly");
  const nextDate = dateTime(next[2]);
  const rules = $(".grupo-info > .pre-message").first().clone();
  rules.find("br").replaceWith("\n");
  const regras_texto = rules.text().trim();
  if (!regras_texto) throw new Error("Missing group rules");
  return {
    contemplados_sorteio: integer(field("Contemplados por sorteio")),
    contemplados_lance: integer(field("Contemplados por lance")),
    percentual_embutido: percent(field("Lance Embutido")),
    numero_consorciados: integer(field("Número de consorciados")),
    dia_vencimento: integer(field("Vencimento dia"), 1, 31),
    percentual_fundo_reserva: percent(field("Fundo reserva")),
    percentual_seguro: percent(field("Taxa de seguro")),
    tipo_sorteio: field("Tipo de sorteio"), tipo_seguro: field("Tipo de seguro"), tipo_grupo: field("Tipo de grupo"),
    proxima_assembleia_numero: integer(next[1], 1),
    proxima_assembleia_em: `${nextDate.data}T${nextDate.horario}:00-03:00`,
    previsao_reajuste: date(field("Previsão para o próximo reajuste (sujeito a alteração em caso de gatilho para o índice)")),
    regras_texto,
  };
}
function parsePlans($: CheerioAPI): GroupPlan[] {
  const tables = tableWithHeaders($, ["Categoria", "Descrição", "Valor do Crédito", "Prazo", "% Mensal", "Parcela (Sem Seguro)", "Seguro", "Observação", "Total (Parcela + Seguro)"]);
  const rates = $(".tabs a").map((_, e) => text($(e).text())).get().filter((s) => s.startsWith("Taxa de Adm"));
  if (!tables.length || tables.length !== rates.length) throw new Error("Missing or inconsistent group plan tables/rates");
  const plans = tables.flatMap((table, index) => {
    const rate = /([\d.,]+)%$/.exec(rates[index]);
    if (!rate) throw new Error("Invalid group administration rate");
    const items = rows($, table, 10);
    if (!items.length) throw new Error("Unexpected empty group plan table");
    return items.map(({ cells: c, element }) => {
      if (!c[0] || !c[1]) throw new Error("Missing group plan identity");
      const originalTerm = $(element).attr("data-url")?.split("/").at(-2);
      return {
        categoria: c[0], descricao: c[1], taxa_administracao: percent(rate[1]),
        prazo_meses: integer(c[3], 1), prazo_original_meses: integer(originalTerm ?? c[3], 1),
        valor_credito: groupNumber(c[2]), percentual_mensal: percent(c[4]),
        parcela_sem_seguro: groupNumber(c[5]), seguro: groupNumber(c[6]), observacao: c[7], parcela_total: groupNumber(c[8]),
      };
    });
  });
  return unique(plans, groupPlanKey);
}
function parseAssemblies($: CheerioAPI): GroupAssembly[] {
  const tables = tableWithHeaders($, ["Assembléia", "Data", "Local", "Cidade", "Situação", "Visualizar"]);
  if (tables.length !== 1) throw new Error("Missing group assembly table");
  const items = rows($, tables[0], 6).map(({ cells: c }) => {
    if (!c[2] || !c[3] || !["realizada", "a realizar"].includes(normalized(c[4]))) throw new Error("Unknown assembly location/status");
    return { numero: integer(c[0], 1), ...dateTime(c[1]), local: c[2], cidade: c[3], situacao: c[4] };
  });
  if (!items.length) throw new Error("Unexpected empty group assembly table");
  return unique(items, (item) => String(item.numero));
}
export function parseGroupHistory(html: string, group: number, mode: GroupMode): GroupSection<GroupBidHistory[]> {
  assertGroupPage(html, group);
  const $ = load(html);
  const tables = tableWithHeaders($, ["Assembléia", "Data", "Maior Lance", "Menor Lance", "Tipo", "Quantidade"]);
  if (!tables.length && normalized($(".main-view-container").text()).includes("historico nao encontrado para esta modalidade de lance")) {
    return { status: "sem_historico" };
  }
  return captureGroupSection(() => {
    if (tables.length !== 1) throw new Error("Missing group bid history table");
    const items = rows($, tables[0], 6).map(({ cells: c }) => {
      if (normalized(c[4]).replace(/ /g, "_") !== mode) throw new Error("Group bid history modality mismatch");
      return { assembleia_numero: integer(c[0], 1), data: date(c[1]), modalidade: mode,
        maior_lance: percent(c[2]), menor_lance: percent(c[3]), quantidade: integer(c[5]) };
    });
    if (!items.length) throw new Error("Unexpected empty group bid history table");
    return unique(items, (item) => `${item.assembleia_numero}:${item.modalidade}`);
  });
}
export function parseGroupDetails(html: string, group: number) {
  assertGroupPage(html, group);
  const $ = load(html);
  return {
    cadastro: captureGroupSection(() => parseCharacteristics($)),
    planos: captureGroupSection(() => parsePlans($)),
    assembleias: captureGroupSection(() => parseAssemblies($)),
    historico_sem_embutido: parseGroupHistory(html, group, "sem_embutido"),
  };
}
