import { HttpClient } from "./http-client.js";
import { extractInfoBlockValue } from "../parsers.js";

const BASE_URL = "https://www.consorcioservopa.com.br";
const EXTRATO_PATH = "/vendas/extrato";

export interface ServopaCustomerRef {
  grupo: string;
  digito: string;
  plano: string;
  nr_contrato: string;
}

export interface CustomerDueDateResult extends ServopaCustomerRef {
  activatedCustomerUrl: string;
  rawContrato: string | null;
  rawVencimento: string | null;
  dt_vencimento: string | null;
  customerContextConfirmed: boolean;
}

function normalizePlanoForPanel(plano: string): string {
  const normalized = String(plano).trim().replace(/^0+/, "");
  return normalized || "0";
}

function toIsoDate(ddmmyyyy: string): string | null {
  const match = String(ddmmyyyy).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function inferDueDateFromMaskedValue(rawValue: string): string | null {
  const raw = String(rawValue).trim();
  const maskedMatch = raw.match(/^(\d{1,2})\/\*{1,2}\/\*{2,4}$/);
  if (!maskedMatch) {
    return toIsoDate(raw);
  }

  const dueDay = Number.parseInt(maskedMatch[1], 10);
  if (Number.isNaN(dueDay)) {
    return null;
  }

  const todayInBrt = new Date(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date())
  );

  let targetYear = todayInBrt.getUTCFullYear();
  let targetMonth = todayInBrt.getUTCMonth();

  if (todayInBrt.getUTCDate() > dueDay) {
    targetMonth += 1;
    if (targetMonth > 11) {
      targetMonth = 0;
      targetYear += 1;
    }
  }

  const daysInTargetMonth = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0)
  ).getUTCDate();
  const safeDay = String(Math.min(dueDay, daysInTargetMonth)).padStart(2, "0");
  const safeMonth = String(targetMonth + 1).padStart(2, "0");

  return `${targetYear}-${safeMonth}-${safeDay}`;
}

export function buildCustomerPanelPath(customer: ServopaCustomerRef): string {
  return `/vendas/painel/${customer.grupo}/${customer.digito}/${normalizePlanoForPanel(customer.plano)}/${customer.nr_contrato}/V`;
}

export async function activateCustomerContext(
  client: HttpClient,
  customer: ServopaCustomerRef
): Promise<{
  activatedCustomerPath: string;
  activatedCustomerUrl: string;
}> {
  const activatedCustomerPath = buildCustomerPanelPath(customer);
  const activateResp = await client.get(activatedCustomerPath);
  if (!activateResp.ok) {
    throw new Error(
      `Failed to activate customer context - HTTP ${activateResp.status}`
    );
  }

  return {
    activatedCustomerPath,
    activatedCustomerUrl: `${BASE_URL}${activatedCustomerPath}`,
  };
}

export async function getCustomerDueDate(
  client: HttpClient,
  customer: ServopaCustomerRef
): Promise<CustomerDueDateResult> {
  const { activatedCustomerUrl } = await activateCustomerContext(client, customer);

  const extratoResp = await client.get(EXTRATO_PATH);
  if (!extratoResp.ok) {
    throw new Error(`Failed to fetch extrato - HTTP ${extratoResp.status}`);
  }

  const html = await extratoResp.text();
  const rawVencimento = extractInfoBlockValue(html, "VENCIMENTO");
  const rawContrato = extractInfoBlockValue(html, "Contrato");

  if (!rawVencimento || !rawContrato) {
    throw new Error("Could not extract contrato/vencimento from extrato");
  }

  return {
    ...customer,
    activatedCustomerUrl,
    rawContrato,
    rawVencimento,
    dt_vencimento: inferDueDateFromMaskedValue(rawVencimento),
    customerContextConfirmed: rawContrato === customer.nr_contrato,
  };
}
