function replaceTemplateValue(
  template: string,
  key: string,
  value: string,
): string {
  return template.replace(new RegExp(`{{${key}}}`, "g"), value);
}

function toTitleCaseWord(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "";

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function formatCustomerFirstName(
  name: string | null | undefined,
): string {
  const rawName = String(name || "").trim();
  if (!rawName) {
    return "Cliente";
  }

  const [firstToken] = rawName.split(/\s+/);
  const formatted = toTitleCaseWord(firstToken);

  return formatted || "Cliente";
}

export const PAYMENT_DUE_D1_TEMPLATE = [
  "Bom dia, {{name}}. Tudo bem?",
  "",
  "Passando aqui para te avisar que a parcela da sua cota {{cota}} vence depois de amanhã!",
  "",
  "Caso você precise do boleto para realizar o pagamento, estou enviando aqui o link de acesso!",
  "",
  "Lembrando que a adimplência possibilita sua participação no sorteio geral e no lance fidelidade!",
  "",
  "Se você já efetuou o pagamento, desconsidere a mensagem acima. Aproveito também para desejar a você um ótimo dia e uma excelente semana.",
  "",
  "Até logo!",
].join("\n");

export const BIRTHDAY_TEMPLATE = [
  "Olá, {{name}}!",
  "",
  "Hoje é um dia especial, e toda a equipe do Grupo Capuzzo deseja a você um feliz aniversário!",
  "",
  "Que este novo ciclo seja repleto de saúde, prosperidade, conquistas e muitos momentos felizes.",
  "",
  "Obrigado por confiar em nosso trabalho e fazer parte da nossa história. Conte sempre com a gente!",
].join("\n");

export const CONTEMPLATION_TEMPLATE = [
  "PARABÉNS, {{name}}!",
  "",
  "Temos uma notícia incrível para você: sua cota {{cota}} (contrato {{contrato}}) foi contemplada!",
  "",
  "Esse é um momento muito especial, porque representa mais um passo na realização do sonho que te trouxe até aqui.",
  "",
  "Ficamos muito felizes em fazer parte dessa conquista junto com você!",
  "Acabamos de enviar um PDF com todas as orientações e próximos passos para seguirmos com o processo da sua contemplação de forma tranquila e organizada. Verifique seu e-mail para mais detalhes.",
  "",
  "E pode ficar tranquilo(a): nossa equipe estará ao seu lado durante todo o processo para te auxiliar no que precisar.",
  "Qualquer dúvida, conte com a gente!",
].join("\n");

export const OVERDUE_PAYMENT_D1_TEMPLATE = [
  "Olá, {{name}}! Identificamos uma pendência em aberto na sua cota {{cota}} do consórcio de número {{contract}}.",
  "",
  "É fundamental manter a adimplência para participar dos sorteios e do lance fidelidade. Caso já tenha realizado o pagamento, por favor, desconsidere esta mensagem.",
  "",
  "Às vezes isso pode acontecer por rotina corrida ou atraso na compensação bancária, então estamos passando apenas para acompanhar você. Se precisar de algum auxílio, estamos por aqui!",
].join("\n");

export const OVERDUE_PAYMENT_D7_TEMPLATE = [
  "Olá, {{name}}!",
  "Passando para informar que a sua cota {{cota}} do consórcio {{contract}} ainda aparece com pendência em nosso sistema.",
  "",
  "Para manter sua participação ativa nos benefícios do consórcio e evitar qualquer perda financeira futura, é importante manter a cota regularizada.",
  "",
  "Se precisar do boleto atualizado ou de apoio para verificar a situação, estamos à disposição para ajudar da melhor forma possível.",
  "Caso o pagamento já tenha sido realizado, desconsidere esta mensagem.",
].join("\n");

export const OVERDUE_PAYMENT_D15_TEMPLATE = [
  "Olá, {{name}}! Tudo bem?",
  "Estamos entrando em contato porque a cota {{cota}} do contrato {{contract}} ainda consta com pendência em nosso sistema.",
  "",
  "Queremos te ajudar a manter sua cota ativa e participando normalmente das oportunidades de contemplação e benefícios do grupo.",
  "",
  "Se precisar de suporte, segunda via do boleto ou orientação sobre a melhor forma de regularização, conte com a nossa equipe.",
  "",
  "Caso o pagamento já tenha sido realizado, desconsidere esta mensagem.",
].join("\n");

const OVERDUE_MULTIPLE_PENDENCIES_SUFFIX = [
  "",
  "Identificamos também outras pendências vinculadas ao contrato.",
  "Para verificar a melhor forma de regularização, recomendamos entrar em contato com a nossa equipe.",
].join("\n");

function formatCota(cota: string | null | undefined): string {
  return String(cota || "---").trim() || "---";
}

function formatContrato(contrato: string | null | undefined): string {
  return String(contrato || "---").trim() || "---";
}

export function buildPaymentDueD1Message(
  name: string | null | undefined,
  cota: string | null | undefined,
): string {
  const safeName = formatCustomerFirstName(name);
  const safeCota = formatCota(cota);

  return replaceTemplateValue(
    replaceTemplateValue(PAYMENT_DUE_D1_TEMPLATE, "name", safeName),
    "cota",
    safeCota,
  );
}

export function buildBirthdayReminderMessage(
  name: string | null | undefined,
): string {
  const safeName = formatCustomerFirstName(name);
  return replaceTemplateValue(BIRTHDAY_TEMPLATE, "name", safeName);
}

export function buildContemplationReminderMessage(
  name: string | null | undefined,
  cota: string | null | undefined,
  contrato: string | null | undefined,
): string {
  const safeName = formatCustomerFirstName(name);
  const safeCota = formatCota(cota);
  const safeContrato = formatContrato(contrato);

  return replaceTemplateValue(
    replaceTemplateValue(
      replaceTemplateValue(CONTEMPLATION_TEMPLATE, "name", safeName),
      "cota",
      safeCota,
    ),
    "contrato",
    safeContrato,
  );
}

function buildOverduePaymentMessage(
  template: string,
  name: string | null | undefined,
  contract: string | null | undefined,
  cota: string | null | undefined,
  hasMultiplePendencies: boolean,
): string {
  const safeName = formatCustomerFirstName(name);
  const safeContract = formatContrato(contract);
  const safeCota = formatCota(cota);
  const baseMessage = replaceTemplateValue(
    replaceTemplateValue(
      replaceTemplateValue(template, "name", safeName),
      "contract",
      safeContract,
    ),
    "cota",
    safeCota,
  );

  return hasMultiplePendencies
    ? `${baseMessage}\n${OVERDUE_MULTIPLE_PENDENCIES_SUFFIX}`
    : baseMessage;
}

export function buildOverduePaymentD1Message(
  name: string | null | undefined,
  contract: string | null | undefined,
  cota: string | null | undefined,
  hasMultiplePendencies: boolean,
): string {
  return buildOverduePaymentMessage(
    OVERDUE_PAYMENT_D1_TEMPLATE,
    name,
    contract,
    cota,
    hasMultiplePendencies,
  );
}

export function buildOverduePaymentD7Message(
  name: string | null | undefined,
  contract: string | null | undefined,
  cota: string | null | undefined,
  hasMultiplePendencies: boolean,
): string {
  return buildOverduePaymentMessage(
    OVERDUE_PAYMENT_D7_TEMPLATE,
    name,
    contract,
    cota,
    hasMultiplePendencies,
  );
}

export function buildOverduePaymentD15Message(
  name: string | null | undefined,
  contract: string | null | undefined,
  cota: string | null | undefined,
  hasMultiplePendencies: boolean,
): string {
  return buildOverduePaymentMessage(
    OVERDUE_PAYMENT_D15_TEMPLATE,
    name,
    contract,
    cota,
    hasMultiplePendencies,
  );
}

function getCurrentMonthNameInPortuguese(date = new Date()): string {
  return new Intl.DateTimeFormat("pt-BR", {
    month: "long",
    timeZone: "America/Sao_Paulo",
  }).format(date);
}

export function buildBidReceiptMessage(
  name: string | null | undefined,
  contract: string | null | undefined,
  cota: string | null | undefined,
  date = new Date(),
): string {
  const safeName = formatCustomerFirstName(name);
  const safeContract = formatContrato(contract);
  const safeCota = formatCota(cota);
  const safeMonth = getCurrentMonthNameInPortuguese(date);

  return [
    `Segue o comprovante do seu lance referente ao mês de ${safeMonth} 🍀`,
    "",
    `Contrato: ${safeContract}`,
    `Cota: ${safeCota}`,
    "",
    `Agora é torcer pela contemplação, ${safeName}! ✨`,
    "",
    "Qualquer dúvida, estamos à disposição.",
  ].join("\n");
}
