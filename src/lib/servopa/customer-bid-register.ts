import { HttpClient } from "./http-client.js";

const REGISTER_PATH = "/vendas/lances-register";
const DOCGEN_LANCE_URL = "https://www.consorcioservopa.com.br/docgen/lance/index.php";
const DOCPARSER_VIEW_URL = "https://www.consorcioservopa.com.br/docparser/view/";

export interface BidRegisterResponse {
  result: boolean;
  protocolo: string;
  dtEventoEd: string;
  hrEventoEd: string;
  raw: Record<string, unknown>;
}

export interface BidComprovantePayload {
  num_protocolo_ant: string;
  digito: string;
  grupo: string;
  plano: string;
  nmCliente: string;
  nrAssemb: string;
  dtEditada: string;
  hrEditada: string;
  local: string;
  bem_referencia: string;
  txLanfix: string;
  vlLanfix: string;
  qtLanfid: string;
  txLanfid: string;
  vlLanfid: string;
  txLanliv: string;
  vlLanliv: string;
  data: string;
  hora: string;
  st_evento: string;
  dsDescr15: string;
}

export interface CustomerBidRegisterResult {
  registerResponse: BidRegisterResponse;
  comprovantePayload: BidComprovantePayload;
  comprovanteUrl: string;
}

function decodeRegisterResponse(responseBody: unknown): BidRegisterResponse {
  const parsed =
    typeof responseBody === "string"
      ? (JSON.parse(responseBody) as Record<string, unknown>)
      : (responseBody as Record<string, unknown>);

  return {
    result: parsed.result === true,
    protocolo: String(parsed.protocolo ?? ""),
    dtEventoEd: String(parsed.dtEventoEd ?? "").replace(/\\\//g, "/"),
    hrEventoEd: String(parsed.hrEventoEd ?? ""),
    raw: parsed,
  };
}

function cleanQuantity(value: string | null | undefined): string {
  const text = String(value ?? "");
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

export function buildBidComprovantePayload(input: {
  registerResponse: BidRegisterResponse;
  registerPayload: Record<string, string>;
  currentInfo: {
    name: string | null;
    asset_name: string | null;
  };
  eventInfo: {
    nrAssemb: string | null;
    dtEditada: string | null;
    hrEditada: string | null;
    local: string | null;
  };
}): BidComprovantePayload {
  const { registerResponse, registerPayload, currentInfo, eventInfo } = input;
  const isFixo = registerPayload.st_evento === "F";
  const isFidelidade = registerPayload.st_evento === "D";

  return {
    num_protocolo_ant: registerResponse.protocolo,
    digito: registerPayload.digito ?? "",
    grupo: registerPayload.grupo ?? "",
    plano: registerPayload.plano ?? "",
    nmCliente: currentInfo.name ?? "",
    nrAssemb: eventInfo.nrAssemb ?? "",
    dtEditada: eventInfo.dtEditada ?? "",
    hrEditada: eventInfo.hrEditada ?? "",
    local: eventInfo.local ?? "",
    bem_referencia: currentInfo.asset_name ?? "",
    txLanfix: isFixo ? registerPayload.tx_lanfix ?? "" : "",
    vlLanfix: isFixo ? registerPayload.vl_lanfix ?? "" : "",
    qtLanfid: isFidelidade
      ? cleanQuantity(registerPayload.qt_lan_fid ?? registerPayload.qtLanfid)
      : "",
    txLanfid: isFidelidade ? cleanQuantity(registerPayload.tx_lan_fid) : "",
    vlLanfid: isFidelidade ? registerPayload.vl_lanfid_emb ?? "" : "",
    txLanliv: "",
    vlLanliv: "R$ 0,00",
    data: registerResponse.dtEventoEd,
    hora: registerResponse.hrEventoEd,
    st_evento: registerPayload.st_evento ?? "",
    dsDescr15: registerPayload.dsDescr15 ?? "",
  };
}

export function buildBidComprovanteUrl(
  comprovantePayload: BidComprovantePayload,
): string {
  const wrapper = {
    url: DOCGEN_LANCE_URL,
    data: comprovantePayload,
  };

  const token = Buffer.from(JSON.stringify(wrapper), "utf8").toString("base64");
  return `${DOCPARSER_VIEW_URL}${token}`;
}

export async function registerCustomerBid(
  client: HttpClient,
  registerPayload: Record<string, string>,
  metadata: {
    currentInfo: {
      name: string | null;
      asset_name: string | null;
    };
    eventInfo: {
      nrAssemb: string | null;
      dtEditada: string | null;
      hrEditada: string | null;
      local: string | null;
    };
  },
): Promise<CustomerBidRegisterResult> {
  const response = await client.postRaw(
    REGISTER_PATH,
    JSON.stringify(registerPayload),
    {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to register bid - HTTP ${response.status}`);
  }

  const responseBody = await response.text();
  const registerResponse = decodeRegisterResponse(responseBody);
  if (!registerResponse.result) {
    throw new Error(
      String(registerResponse.raw.err ?? "Servopa register response returned result=false"),
    );
  }

  const comprovantePayload = buildBidComprovantePayload({
    registerResponse,
    registerPayload,
    currentInfo: metadata.currentInfo,
    eventInfo: metadata.eventInfo,
  });

  return {
    registerResponse,
    comprovantePayload,
    comprovanteUrl: buildBidComprovanteUrl(comprovantePayload),
  };
}
