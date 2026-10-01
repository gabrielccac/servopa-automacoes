import { HttpClient } from "./http-client.js";
import {
  activateCustomerContext,
  type ServopaCustomerRef,
} from "./customer-context.js";
import type { Element } from "domhandler";
import { stripTags, extractInfoBlockValue } from "../parsers.js";
import { load, type CheerioAPI } from "cheerio";

const BASE_URL = "https://www.consorcioservopa.com.br";
const EXTRATO_PATH = "/vendas/extrato";

export interface CustomerPaymentInstallment {
  nr_parcela: number | null;
  ds_tipo: string | null;
  vl_seguro: number | null;
  vl_emitido: number | null;
  pc_a_pagar: number | null;
  vl_atual: number | null;
  vl_com_seguro: number | null;
  vl_acumulado: number | null;
  boleto_url: string | null;
  pix_url: string | null;
  nr_assembleia: number | null;
  dt_pagamento: string | null;
  vl_multa: number | null;
  vl_prestacao: number | null;
  pc_pago: number | null;
}

export interface CustomerPaymentInfoResult extends ServopaCustomerRef {
  activatedCustomerUrl: string;
  customerContextConfirmed: boolean;
  rawContrato: string | null;
  boletos: CustomerPaymentInstallment[];
  parcelas: CustomerPaymentInstallment[];
  paymentStatus: "eligible" | "skipped";
  message: string | null;
}

function parseMoney(value: string): number | null {
  const normalized = stripTags(value)
    .replace(/R\$\s*/i, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function parsePercent(value: string): number | null {
  const normalized = stripTags(value).replace(/%/g, "").replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseIntValue(value: string): number | null {
  const parsed = Number.parseInt(stripTags(value), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseBrDate(value: string): string | null {
  const match = stripTags(value).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

function isNotNull<T>(value: T | null): value is T {
  return value !== null;
}

function absolutizeUrl(value: string | undefined): string | null {
  if (!value) return null;
  return value.startsWith("http")
    ? value
    : `${BASE_URL}${value.startsWith("/") ? "" : "/"}${value}`;
}

function findPaymentBlock($: CheerioAPI, title: string) {
  return $(".block")
    .filter((_, element) => {
      const heading = $(element).find("h2").first().text();
      return stripTags(heading).includes(title);
    })
    .first();
}

function readRowCells($: CheerioAPI, row: Element): string[] {
  return $(row)
    .find("td")
    .map((_, cell) => stripTags($(cell).text()))
    .get();
}

function findRowActionUrl(
  $: CheerioAPI,
  row: Element,
  label: string,
  attr: "href" | "data-src"
): string | null {
  const action = $(row)
    .find("a")
    .filter((_, anchor) => stripTags($(anchor).text()).includes(label))
    .first();

  return absolutizeUrl(action.attr(attr));
}

function parseBoletos($: CheerioAPI): CustomerPaymentInstallment[] {
  const block = findPaymentBlock($, "Parcelas Emitidas");
  if (!block.length) return [];

  return block
    .find("tbody tr")
    .map((_, row) => {
      const cells = readRowCells($, row);
      if (cells.length < 8) return null;

      return {
        nr_parcela: parseIntValue(cells[0]),
        ds_tipo: cells[1] || null,
        vl_seguro: parseMoney(cells[2]),
        vl_emitido: parseMoney(cells[3]),
        pc_a_pagar: parsePercent(cells[4]),
        vl_atual: parseMoney(cells[5]),
        vl_com_seguro: parseMoney(cells[6]),
        vl_acumulado: parseMoney(cells[7]),
        boleto_url: findRowActionUrl($, row, "Gerar Boleto", "href"),
        pix_url: findRowActionUrl($, row, "Pagar com PIX", "data-src"),
        nr_assembleia: null,
        dt_pagamento: null,
        vl_multa: null,
        vl_prestacao: null,
        pc_pago: null,
      };
    })
    .get()
    .filter(isNotNull);
}

function parseParcelas($: CheerioAPI): CustomerPaymentInstallment[] {
  const block = findPaymentBlock($, "Parcelas Pagas");
  if (!block.length) return [];

  return block
    .find("tbody tr")
    .map((_, row) => {
      const cells = readRowCells($, row);
      if (cells.length < 8) return null;

      return {
        nr_parcela: parseIntValue(cells[0]),
        ds_tipo: cells[1] || null,
        nr_assembleia: parseIntValue(cells[2]),
        dt_pagamento: parseBrDate(cells[3]),
        vl_seguro: parseMoney(cells[4]),
        vl_multa: parseMoney(cells[5]),
        vl_prestacao: parseMoney(cells[6]),
        pc_pago: parsePercent(cells[7]),
        vl_emitido: null,
        pc_a_pagar: null,
        vl_atual: null,
        vl_com_seguro: null,
        vl_acumulado: null,
        boleto_url: null,
        pix_url: null,
      };
    })
    .get()
    .filter(isNotNull);
}

export async function getCustomerPaymentInfo(
  client: HttpClient,
  customer: ServopaCustomerRef
): Promise<CustomerPaymentInfoResult> {
  const { activatedCustomerUrl } = await activateCustomerContext(client, customer);

  const extratoResp = await client.get(EXTRATO_PATH);
  if (!extratoResp.ok) {
    throw new Error(`Failed to fetch extrato - HTTP ${extratoResp.status}`);
  }

  const html = await extratoResp.text();
  const $ = load(html);
  const rawContrato = extractInfoBlockValue(html, "Contrato");
  const boletos = parseBoletos($);
  const parcelas = parseParcelas($);
  const customerContextConfirmed = rawContrato === customer.nr_contrato;

  if (!rawContrato) {
    throw new Error(
      "Could not confirm customer contract from extrato response"
    );
  }

  if (!customerContextConfirmed) {
    throw new Error(
      `Customer context mismatch in extrato response - expected ${customer.nr_contrato}, got ${rawContrato}`
    );
  }

  const paymentStatus = boletos.length > 0 ? "eligible" : "skipped";
  const message =
    paymentStatus === "eligible"
      ? null
      : "Payment information is not available right now";

  return {
    ...customer,
    activatedCustomerUrl,
    customerContextConfirmed,
    rawContrato,
    boletos,
    parcelas,
    paymentStatus,
    message,
  };
}
