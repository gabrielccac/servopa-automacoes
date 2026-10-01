import { load } from "cheerio";
import { HttpClient } from "./http-client.js";
import {
  activateCustomerContext,
  type ServopaCustomerRef,
} from "./customer-context.js";
import { decodeEntities, stripTags } from "../parsers.js";

const LANCES_PATH = "/vendas/lances";

export interface BidSimulationCurrentInfo {
  grupo: string | null;
  cota: string | null;
  contrato: string | null;
  name: string | null;
  asset_name: string | null;
  asset_value: string | null;
}

export interface BidSimulationEventInfo {
  nrAssemb: string | null;
  dtEditada: string | null;
  hrEditada: string | null;
  local: string | null;
}

export interface BidSimulationResult extends ServopaCustomerRef {
  activatedCustomerUrl: string;
  customerContextConfirmed: boolean;
  rawContrato: string | null;
  currentInfo: BidSimulationCurrentInfo;
  eventInfo: BidSimulationEventInfo;
  simulationRequestPayload: Record<string, string>;
  registerPayload: Record<string, string>;
}

function cleanText(value: string | null | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseFormById(html = "", formId = "frm_lance"): string {
  const regex = new RegExp(
    `<form[^>]*id=["']${formId}["'][^>]*>([\\s\\S]*?)<\\/form>`,
    "i",
  );
  const match = regex.exec(html);
  return match ? match[0] : "";
}

function extractInputs(html = "", includeDisabled = true): Record<string, string> {
  const inputs: Record<string, string> = {};
  const inputRegex = /<input\b[^>]*>/gi;
  const nameRegex = /\bname=["']([^"']+)["']/i;
  const valueRegex = /\bvalue=["']([^"']*)["']/i;
  const typeRegex = /\btype=["']([^"']+)["']/i;

  let match: RegExpExecArray | null;
  while ((match = inputRegex.exec(html)) !== null) {
    const raw = match[0];
    const nameMatch = raw.match(nameRegex);
    if (!nameMatch?.[1]) continue;

    const name = decodeEntities(nameMatch[1]);
    const value = decodeEntities((raw.match(valueRegex) || [null, ""])[1]);
    const type = String((raw.match(typeRegex) || [null, "text"])[1]).toLowerCase();
    const disabled = /\bdisabled\b/i.test(raw);
    const checked = /\bchecked\b/i.test(raw);

    if (disabled && !includeDisabled) continue;
    if ((type === "radio" || type === "checkbox") && !checked) continue;

    inputs[name] = value;
  }

  return inputs;
}

interface RadioOption {
  name: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  percentual: string;
  valor_lance: string;
  periodo_fidelidade_meses: string;
}

function extractRadioOptions(html = ""): RadioOption[] {
  const options: RadioOption[] = [];
  const inputRegex = /<input\b[^>]*>/gi;
  const nameRegex = /\bname=["']([^"']+)["']/i;
  const valueRegex = /\bvalue=["']([^"']*)["']/i;
  const typeRegex = /\btype=["']([^"']+)["']/i;

  let match: RegExpExecArray | null;
  while ((match = inputRegex.exec(html)) !== null) {
    const raw = match[0];
    const type = String((raw.match(typeRegex) || [null, ""])[1]).toLowerCase();
    if (type !== "radio") continue;

    const value = decodeEntities((raw.match(valueRegex) || [null, ""])[1]);
    const [percentual, valorLance, periodoFidelidadeMeses] = value.split("_");

    options.push({
      name: decodeEntities((raw.match(nameRegex) || [null, ""])[1]),
      value,
      checked: /\bchecked\b/i.test(raw),
      disabled: /\bdisabled\b/i.test(raw),
      percentual: percentual ?? "",
      valor_lance: valorLance ?? "",
      periodo_fidelidade_meses: periodoFidelidadeMeses ?? "",
    });
  }

  return options;
}

function parseCurrentInfo(html: string): BidSimulationCurrentInfo {
  const $ = load(html);
  const infoSpans = $(".current-info-data span").toArray();
  const values = infoSpans.map((element) => cleanText($(element).text()));

  const pick = (label: string): string | null => {
    const match = values.find((value) => value.toLowerCase().startsWith(`${label}:`));
    return match ? cleanText(match.slice(label.length + 1)) || null : null;
  };

  return {
    grupo: pick("grupo"),
    cota: pick("cota"),
    contrato: pick("contrato"),
    name: cleanText($(".current-info .name").first().text()) || null,
    asset_name: cleanText($(".current-info .asset-name").first().text()) || null,
    asset_value: cleanText($(".current-info .asset-value").first().text()) || null,
  };
}

function parsePrintObjTemplate(html = ""): Record<string, string> {
  const blockMatch = /var\s+printObj\s*=\s*\{([\s\S]*?)\}\s*;?/i.exec(html);
  if (!blockMatch) return {};

  const block = blockMatch[1];
  const read = (key: string) => {
    const regex = new RegExp(`${key}\\s*:\\s*['"]([^'"]*)['"]`);
    const match = regex.exec(block);
    return match ? decodeEntities(match[1]) : "";
  };

  return {
    nrAssemb: read("nrAssemb"),
    dtEditada: read("dtEditada"),
    hrEditada: read("hrEditada"),
    local: read("local"),
  };
}

function textAfterLabel(html = "", label: string): string {
  const liRegex = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;

  while ((match = liRegex.exec(html)) !== null) {
    const li = match[1];
    const spanMatch = /<span\b[^>]*>([\s\S]*?)<\/span>/i.exec(li);
    const strongMatch = /<strong\b[^>]*>([\s\S]*?)<\/strong>/i.exec(li);

    if (spanMatch && strongMatch && stripTags(spanMatch[1]).toLowerCase() === label.toLowerCase()) {
      return stripTags(strongMatch[1]);
    }
  }

  return "";
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = cleanText(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function parseEventInfo(html = ""): BidSimulationEventInfo {
  const printObj = parsePrintObjTemplate(html);

  return {
    nrAssemb: firstNonEmpty(
      printObj.nrAssemb,
      textAfterLabel(html, "Assembléia"),
      textAfterLabel(html, "Assembleia"),
    ),
    dtEditada: firstNonEmpty(printObj.dtEditada, textAfterLabel(html, "Data")),
    hrEditada: firstNonEmpty(printObj.hrEditada),
    local: firstNonEmpty(printObj.local),
  };
}

function parseBidType(value: string): "FIXO" | "FIDELIDADE" {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "FIXO" || normalized === "FIDELIDADE") {
    return normalized;
  }

  throw new Error(`Unsupported tp_lance: ${value}. Use FIXO or FIDELIDADE.`);
}

function percentNumber(value: number | string): string {
  const number = String(value ?? "30").replace(/\D/g, "");
  return number || "30";
}

function parseBooleanToSN(value: string | boolean | null | undefined): "S" | "N" {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["s", "sim", "true", "1", "yes", "y"].includes(normalized)) return "S";
    if (["n", "nao", "não", "false", "0", "no"].includes(normalized)) return "N";
  }

  return value === false ? "N" : "S";
}

function findFidelityOption(radioOptions: RadioOption[], percent: string): RadioOption {
  const option = radioOptions.find(
    (radio) =>
      radio.name === "fidelidade-option" &&
      radio.percentual === percent &&
      radio.disabled === false,
  );

  if (!option) {
    const available = radioOptions
      .filter((radio) => radio.name === "fidelidade-option" && !radio.disabled)
      .map((radio) => radio.value);
    throw new Error(
      `No enabled fidelity option found for ${percent}%. Available: ${available.join(", ")}`,
    );
  }

  return option;
}

function buildSimulationPayload(
  bidType: "FIXO" | "FIDELIDADE",
  percent: string,
  diluicao: "S" | "N",
  formInputs: Record<string, string>,
  radioOptions: RadioOption[],
): Record<string, string> {
  if (bidType === "FIDELIDADE") {
    const fidelityOption = findFidelityOption(radioOptions, percent);

    return {
      stLanse: formInputs.stLanse ?? "N",
      lance: "D",
      "fidelidade-option": fidelityOption.value,
      tx_lanfid_emb: percent,
      vl_lanfid_emb: formInputs.vl_lanfid_emb ?? "0,00",
      qtLanfid: formInputs.qtLanfid ?? "0.0",
      st_lanse: formInputs.st_lanse ?? "N",
      diluicao,
      simular: formInputs.simular ?? "1",
      tp_lance: "D",
    };
  }

  return {
    stLanse: "S",
    lance: "F",
    tx_lanfid_emb: formInputs.tx_lanfid_emb ?? "0",
    vl_lanfid_emb: formInputs.vl_lanfid_emb ?? "0,00",
    qtLanfid: formInputs.qtLanfid ?? "0.0",
    tx_lanfix: percent,
    vl_lanfix: formInputs.vl_lanfix ?? "",
    tx_lanfix_emb: percent,
    vl_lanfix_emb: formInputs.vl_lanfix_emb ?? "",
    tx_Lanliv: formInputs.tx_Lanliv ?? "",
    vl_lanliv: formInputs.vl_lanliv ?? "",
    tx_lanliv_emb: formInputs.tx_lanliv_emb ?? "",
    vl_lanliv_emb: formInputs.vl_lanliv_emb ?? "",
    diluicao,
    simular: formInputs.simular ?? "1",
    tp_lance: "E",
  };
}

export async function simulateCustomerBid(
  client: HttpClient,
  customer: ServopaCustomerRef,
  input: {
    tp_lance: string;
    pct_lance: number;
    diluicao_em_parcelas?: string | boolean | null;
  },
): Promise<BidSimulationResult> {
  const { activatedCustomerUrl } = await activateCustomerContext(client, customer);
  const bidType = parseBidType(input.tp_lance);
  const percent = percentNumber(input.pct_lance);
  const diluicao = parseBooleanToSN(input.diluicao_em_parcelas);

  const lancesResp = await client.get(LANCES_PATH);
  if (!lancesResp.ok) {
    throw new Error(`Failed to fetch lances form - HTTP ${lancesResp.status}`);
  }

  const lancesHtml = await lancesResp.text();
  const currentInfo = parseCurrentInfo(lancesHtml);
  const eventInfo = parseEventInfo(lancesHtml);
  const formHtml = parseFormById(lancesHtml, "frm_lance");

  if (!formHtml) {
    throw new Error(
      "Could not find frm_lance. Contract may not be selected or session may be expired.",
    );
  }

  const formInputs = extractInputs(formHtml, true);
  const radioOptions = extractRadioOptions(formHtml);
  const simulationPayload = buildSimulationPayload(
    bidType,
    percent,
    diluicao,
    formInputs,
    radioOptions,
  );

  const simulationResp = await client.post(
    LANCES_PATH,
    new URLSearchParams(simulationPayload),
  );
  if (!simulationResp.ok) {
    throw new Error(`Failed to simulate bid - HTTP ${simulationResp.status}`);
  }

  const simulationHtml = await simulationResp.text();
  const simulationEventInfo = parseEventInfo(simulationHtml);
  const simulatedFormHtml = parseFormById(simulationHtml, "frm_lance");
  if (!simulatedFormHtml) {
    throw new Error("Could not find frm_lance after simulation response");
  }

  const registerPayload = extractInputs(simulatedFormHtml, false);
  registerPayload.contrato = customer.nr_contrato;
  delete registerPayload.valida_protocolo;
  if (!registerPayload.num_protocolo_ant) {
    delete registerPayload.num_protocolo_ant;
  }

  const rawContrato = currentInfo.contrato;

  return {
    ...customer,
    activatedCustomerUrl,
    customerContextConfirmed: rawContrato === customer.nr_contrato,
    rawContrato,
    currentInfo,
    eventInfo: {
      nrAssemb: simulationEventInfo.nrAssemb ?? eventInfo.nrAssemb,
      dtEditada: simulationEventInfo.dtEditada ?? eventInfo.dtEditada,
      hrEditada: simulationEventInfo.hrEditada ?? eventInfo.hrEditada,
      local: simulationEventInfo.local ?? eventInfo.local,
    },
    simulationRequestPayload: simulationPayload,
    registerPayload,
  };
}
