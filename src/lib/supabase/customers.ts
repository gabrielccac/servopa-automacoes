import { altSupabaseRestGetAll, supabaseRestGetAll } from "./client.js";

export interface Customer {
  nr_contrato: string | null;
  nm_consorciado: string | null;
  cd_whatsapp: string | null;
  dt_cancelamento: string | null;
  dt_nasc: string | null;
  nr_cota: string | null;
  dt_contemplacao: string | null;
  nr_diavenc: number | null;
  nr_grupo: string | null;
  nm_cpfcnpj_consorciado?: string | null;
}

interface BirthdayReminderCustomer extends Customer {
  birthday_source: "servopa" | "alt";
}

export interface OverduePaymentRecord {
  nr_contrato: string | null;
  nr_cota: string | null;
  nm_consorciado: string | null;
  cd_whatsapp: string | null;
  dt_vc: number | null;
  qt_pgo: number | null;
  qt_atr: number | null;
  vl_percent_mensal: number | null;
  vl_percent_difer: number | null;
  vl_atraso: number | null;
  dt_ultima_ocorrencia: string | null;
  dt_primeira_ocorrencia: string | null;
  st_ativo: boolean | null;
}

function getSaoPauloFormatter(
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    ...options,
  });
}

function getSaoPauloDatePart(date: Date, type: "year" | "month" | "day"): string {
  const value = getSaoPauloFormatter({
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(date)
    .find((part) => part.type === type)?.value;

  if (!value) {
    throw new Error(`Could not resolve Sao Paulo date ${type}`);
  }

  return value;
}

function extractMonthDay(dateValue: string | null): string | null {
  if (!dateValue) return null;

  const isoMatch = String(dateValue).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[2]}-${isoMatch[3]}`;
  }

  const brMatch = String(dateValue).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brMatch) {
    return `${brMatch[2]}-${brMatch[1]}`;
  }

  const flexibleBrMatch = String(dateValue).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (flexibleBrMatch) {
    const day = flexibleBrMatch[1].padStart(2, "0");
    const month = flexibleBrMatch[2].padStart(2, "0");
    return `${month}-${day}`;
  }

  return null;
}

function getDateInSaoPauloDaysAhead(daysAhead: number, baseDate = new Date()): Date {
  const date = new Date(baseDate);
  date.setDate(date.getDate() + daysAhead);
  return date;
}

function getReferenceDate(asOfDate?: string): Date {
  if (!asOfDate) return new Date();

  const date = new Date(`${asOfDate}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== asOfDate) {
    throw new Error(`Invalid asOfDate: ${asOfDate}`);
  }

  return date;
}

export function getTodayIsoDateInSaoPaulo(date = new Date()): string {
  return [
    getSaoPauloDatePart(date, "year"),
    getSaoPauloDatePart(date, "month"),
    getSaoPauloDatePart(date, "day"),
  ].join("-");
}

export function getDayAfterTomorrowIsoDateInSaoPaulo(date = new Date()): string {
  return getTodayIsoDateInSaoPaulo(getDateInSaoPauloDaysAhead(2, date));
}

function getMonthDayInSaoPaulo(date = new Date()): string {
  return `${getSaoPauloDatePart(date, "month")}-${getSaoPauloDatePart(date, "day")}`;
}

function getDayAfterTomorrowDayInSaoPaulo(date = new Date()): number {
  return Number.parseInt(getSaoPauloDatePart(getDateInSaoPauloDaysAhead(2, date), "day"), 10);
}

interface BirthdayCustomerSourceRow {
  nr_contrato: string | null;
  nm_consorciado: string | null;
  cd_whatsapp: string | null;
  dt_cancelamento: string | null;
  nr_cota: string | null;
  dt_contemplacao: string | null;
  nr_diavenc: number | null;
  nr_grupo: string | null;
  nm_cpfcnpj_consorciado: string | null;
}

interface BdClientesBirthDateRow {
  nm_cpfcnpj_consorciado: string | null;
  dt_nasc: string | null;
}

interface AltBirthdayCustomerRow {
  nome_completo: string | null;
  cpf: string | null;
  telefone?: string | null;
  cd_whatsapp?: string | null;
  phone?: string | null;
  dt_nasc: string | null;
  status: string | null;
}

function normalizeDocument(value: string | null | undefined): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits || null;
}

function getAltBirthdayCustomerPhone(row: AltBirthdayCustomerRow): string | null {
  return [row.cd_whatsapp, row.telefone, row.phone]
    .map((value) => String(value ?? "").trim())
    .find(Boolean) ?? null;
}

export async function fetchActiveBirthdayCustomersToday(asOfDate?: string): Promise<Customer[]> {
  const [customers, birthDates, altCustomers] = await Promise.all([
    supabaseRestGetAll<BirthdayCustomerSourceRow>(
      "/rest/v1/bd_producao?select=nr_contrato,nm_consorciado,cd_whatsapp,dt_cancelamento,nr_cota,dt_contemplacao,nr_diavenc,nr_grupo,nm_cpfcnpj_consorciado&dt_cancelamento=is.null&nm_cpfcnpj_consorciado=not.is.null",
    ),
    supabaseRestGetAll<BdClientesBirthDateRow>(
      "/rest/v1/bd_clientes?select=nm_cpfcnpj_consorciado,dt_nasc&dt_nasc=not.is.null",
    ),
    altSupabaseRestGetAll<AltBirthdayCustomerRow>(
      "/rest/v1/clientes?select=*&status=eq.ativo&dt_nasc=not.is.null",
    ),
  ]);
  const birthDateByCpfCnpj = new Map(
    birthDates
      .filter((row): row is Required<BdClientesBirthDateRow> => Boolean(row.nm_cpfcnpj_consorciado))
      .map((row) => [normalizeDocument(row.nm_cpfcnpj_consorciado), row.dt_nasc] as const)
      .filter((row): row is readonly [string, string] => Boolean(row[0]) && Boolean(row[1])),
  );
  const todayMonthDay = getMonthDayInSaoPaulo(getReferenceDate(asOfDate));
  const servopaCustomers = customers
    .map((row) => ({
      ...row,
      birthday_source: "servopa" as const,
      dt_nasc: row.nm_cpfcnpj_consorciado
        ? (birthDateByCpfCnpj.get(normalizeDocument(row.nm_cpfcnpj_consorciado) ?? "") ?? null)
        : null,
    }))
    .filter((row) => extractMonthDay(row.dt_nasc) === todayMonthDay);
  const servopaDocuments = new Set(
    servopaCustomers
      .map((row) => normalizeDocument(row.nm_cpfcnpj_consorciado))
      .filter((value): value is string => Boolean(value)),
  );
  const altBirthdayCustomers: BirthdayReminderCustomer[] = altCustomers
    .filter((row) => extractMonthDay(row.dt_nasc) === todayMonthDay)
    .filter((row) => {
      const document = normalizeDocument(row.cpf);
      return !document || !servopaDocuments.has(document);
    })
    .map((row) => ({
      nr_contrato: normalizeDocument(row.cpf)
        ? `ALT-${normalizeDocument(row.cpf)}`
        : `ALT-NOCPF-${String(row.nome_completo ?? "").trim().toUpperCase() || "CLIENTE"}`,
      nm_consorciado: row.nome_completo,
      cd_whatsapp: getAltBirthdayCustomerPhone(row),
      dt_cancelamento: null,
      dt_nasc: row.dt_nasc,
      nr_cota: null,
      dt_contemplacao: null,
      nr_diavenc: null,
      nr_grupo: null,
      nm_cpfcnpj_consorciado: row.cpf,
      birthday_source: "alt",
    }));

  return [...servopaCustomers, ...altBirthdayCustomers];
}

export async function fetchUpcomingPaymentReminderCustomers(asOfDate?: string): Promise<Customer[]> {
  const rows = await supabaseRestGetAll<Customer>(
    "/rest/v1/bd_producao?select=nr_contrato,nm_consorciado,cd_whatsapp,dt_cancelamento,nr_cota,dt_contemplacao,nr_diavenc,nr_grupo&dt_cancelamento=is.null&nr_diavenc=not.is.null",
  );
  const targetDay = getDayAfterTomorrowDayInSaoPaulo(getReferenceDate(asOfDate));

  return rows.filter((row) => row.nr_diavenc === targetDay);
}

export async function fetchActiveContemplationCustomersToday(asOfDate?: string): Promise<Customer[]> {
  const rows = await supabaseRestGetAll<Customer>(
    "/rest/v1/bd_producao?select=nr_contrato,nm_consorciado,cd_whatsapp,dt_cancelamento,nr_cota,dt_contemplacao,nr_diavenc,nr_grupo&dt_cancelamento=is.null&dt_contemplacao=not.is.null",
  );
  const todayIso = asOfDate ?? getTodayIsoDateInSaoPaulo();

  return rows.filter((row) => String(row.dt_contemplacao || "").startsWith(todayIso));
}

export async function fetchOverduePaymentRecords(): Promise<OverduePaymentRecord[]> {
  return supabaseRestGetAll<OverduePaymentRecord>(
    "/rest/v1/inadimplentes?select=*&st_ativo=eq.true",
  );
}
