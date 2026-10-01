import { load } from "cheerio";
import { HttpClient } from "./http-client.js";
import {
  activateCustomerContext,
  type ServopaCustomerRef,
} from "./customer-context.js";
import { stripTags } from "../parsers.js";

const LANCES_PATH = "/vendas/lances";

export interface CustomerLanceOption {
  lance_type: "FIDELIDADE" | "FIXO" | "LIVRE";
  pct_lance: number | null;
  vl_lance: string | null;
  periodo_meses: number | null;
  available: boolean;
}

export interface CustomerLanceOptionsResult extends ServopaCustomerRef {
  activatedCustomerUrl: string;
  customerContextConfirmed: boolean;
  rawContrato: string | null;
  allOptions: CustomerLanceOption[];
  availableOptions: CustomerLanceOption[];
  hasFidelidade30: boolean;
  hasFidelidade15: boolean;
}

function cleanText(value: string | null | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseOptionValue(value: string): {
  pct_lance: number | null;
  vl_lance: string | null;
  periodo_meses: number | null;
} {
  const [pctRaw, vlRaw, periodoRaw] = String(value || "").split("_");
  const pctLance = Number.parseInt(pctRaw, 10);
  const periodoMeses = Number.parseInt(periodoRaw, 10);

  return {
    pct_lance: Number.isNaN(pctLance) ? null : pctLance,
    vl_lance: cleanText(vlRaw) || null,
    periodo_meses: Number.isNaN(periodoMeses) ? null : periodoMeses,
  };
}

function parseContractFromPage(html: string): string | null {
  const $ = load(html);
  const infoSpans = $(".current-info-data span").toArray();

  for (const element of infoSpans) {
    const text = cleanText($(element).text());
    const [rawKey, ...rest] = text.split(":");
    if (cleanText(rawKey).toLowerCase() !== "contrato") {
      continue;
    }

    return cleanText(rest.join(":")) || null;
  }

  return null;
}

function parseLanceOptions(html: string): {
  allOptions: CustomerLanceOption[];
  availableOptions: CustomerLanceOption[];
} {
  const $ = load(html);
  const allOptions: CustomerLanceOption[] = [];
  const availableOptions: CustomerLanceOption[] = [];

  $(".fidelidade-options .lance-option").each((_, element) => {
    const radio = $(element).find("input[type='radio']").first();
    const value = cleanText(radio.attr("value"));
    const disabled = radio.attr("disabled") !== undefined;
    const notEligible = $(element).find(".not-available").length > 0;
    const parsedValue = parseOptionValue(value);
    const option: CustomerLanceOption = {
      lance_type: "FIDELIDADE",
      ...parsedValue,
      available: !disabled && !notEligible,
    };

    allOptions.push(option);

    if (option.available) {
      availableOptions.push(option);
    }
  });

  const fixoTab = $(".switcher-tab")
    .filter((_, element) => cleanText($(element).find("h3.title").first().text()) === "Lance Fixo")
    .first();

  if (fixoTab.length > 0) {
    const pctValue = cleanText(
      fixoTab.find("input[name='tx_lanfix']").first().attr("value") ??
        fixoTab.find("input[name='tx_lanfix']").first().val()?.toString(),
    );
    const vlValue = cleanText(
      fixoTab.find("input[name='vl_lanfix']").first().attr("value") ??
        fixoTab.find("input[name='vl_lanfix']").first().val()?.toString(),
    );
    const option: CustomerLanceOption = {
      lance_type: "FIXO",
      pct_lance: Number.isNaN(Number.parseInt(pctValue, 10))
        ? null
        : Number.parseInt(pctValue, 10),
      vl_lance: vlValue || null,
      periodo_meses: null,
      available: Boolean(pctValue || vlValue),
    };

    allOptions.push(option);

    if (option.available) {
      availableOptions.push(option);
    }
  }

  return { allOptions, availableOptions };
}

export async function getCustomerLanceOptions(
  client: HttpClient,
  customer: ServopaCustomerRef,
): Promise<CustomerLanceOptionsResult> {
  const { activatedCustomerUrl } = await activateCustomerContext(client, customer);

  const response = await client.get(LANCES_PATH);
  if (!response.ok) {
    throw new Error(`Failed to fetch lances - HTTP ${response.status}`);
  }

  const html = await response.text();
  const rawContrato = parseContractFromPage(html);
  const { allOptions, availableOptions } = parseLanceOptions(html);

  if (!rawContrato) {
    throw new Error("Could not confirm customer contract from lances response");
  }

  return {
    ...customer,
    activatedCustomerUrl,
    customerContextConfirmed: stripTags(rawContrato) === customer.nr_contrato,
    rawContrato,
    allOptions,
    availableOptions,
    hasFidelidade30: availableOptions.some(
      (option) => option.lance_type === "FIDELIDADE" && option.pct_lance === 30,
    ),
    hasFidelidade15: availableOptions.some(
      (option) => option.lance_type === "FIDELIDADE" && option.pct_lance === 15,
    ),
  };
}
