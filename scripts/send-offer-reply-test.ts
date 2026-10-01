import { readFile } from "node:fs/promises";
import { getZApiConfig, sendButtonActionsMessage } from "../src/lib/whatsapp/zapi.js";

async function loadDotEnv(): Promise<void> {
  const contents = await readFile(".env", "utf8");

  for (const line of contents.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match || process.env[match[1]]) continue;

    const value = match[2].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    process.env[match[1]] = value;
  }
}

async function main(): Promise<void> {
  await loadDotEnv();

  const phone = process.env.ZAPI_TEST_PHONE?.trim();
  if (!phone) throw new Error("ZAPI_TEST_PHONE is required");

  const offerType = "FIDELIDADE";
  const offerPct = 30;
  const requiredEnv = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const group = Number(requiredEnv("ZAPI_TEST_OFFER_GROUP"));
  if (!Number.isSafeInteger(group) || group <= 0) throw new Error("Invalid ZAPI_TEST_OFFER_GROUP");
  const contracts = [
    {
      nr_contrato: requiredEnv("ZAPI_TEST_OFFER_CONTRACT"),
      nr_cota: requiredEnv("ZAPI_TEST_OFFER_COTA"),
      nr_grupo: group,
      nm_consorciado: requiredEnv("ZAPI_TEST_OFFER_CUSTOMER_NAME"),
      dt_vencimento: requiredEnv("ZAPI_TEST_OFFER_DUE_DATE"),
    },
  ];

  const buildButtonId = (action: string): string => {
    const payload = {
      v: 1,
      action,
      tp_lance: offerType,
      pct_lance: offerPct,
      diluicao_em_parcelas: true,
      contratos: contracts,
    };

    return `offer|${encodeURIComponent(JSON.stringify(payload))}`;
  };

  const buttonId = buildButtonId("accept_offer_group");
  const questionsButtonId = buildButtonId("offer_questions");

  const response = await sendButtonActionsMessage(getZApiConfig(), {
    phone,
    message: [
      "\u{1F9EA} TESTE — OFERTA INDIVIDUAL",
      "",
      "Ol\u00e1, Gabriel! Tudo bem?",
      "",
      `Temos uma oportunidade de Lance Fidelidade de 30% para o contrato ${contracts[0].nr_contrato}, cota ${contracts[0].nr_cota}.`,
      "",
      "Ao confirmar, o lance autom\u00e1tico ser\u00e1 ativado para esta cota.",
      "",
      "Escolha uma op\u00e7\u00e3o abaixo:",
    ].join("\n"),
    buttonActions: [
      {
        id: buttonId,
        type: "REPLY",
        label: "Quero participar",
      },
      {
        id: questionsButtonId,
        type: "REPLY",
        label: "Tirar d\u00favidas",
      },
    ],
  });

  console.log(JSON.stringify({
    sent: true,
    phone,
    offerType,
    offerPct,
    contracts,
    buttonId,
    questionsButtonId,
    zapiResponse: response,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
