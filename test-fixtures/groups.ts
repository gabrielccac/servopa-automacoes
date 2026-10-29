export function groupListingFixture(group = 9999) {
  return `<table><thead><tr>${["Grupo", "Segmento", "Meses", "Assembléia", "Lance", "Contemplados", "Vagas", "Visualizar"].map((s) => `<th>${s}</th>`).join("")}</tr></thead>
  <tbody><tr>${[group, "I", 240, 17, 0, 0, "1.018", "Visualizar"].map((s) => `<td>${s}</td>`).join("")}</tr></tbody></table>`;
}
export const groupRulesFixture = `- ORDEM DAS CONTEMPLAÇÕES ATE A 6ª ASSEMBLEIA:
SORTEIO; NUMERO DE CONTEMPLAÇÕES CONFORME SALDO.
- ORDEM DAS CONTEMPLAÇÕES A PARTIR DA 7ª ASSEMBLEIA:
SORTEIO;
SORTEIO;
LANCE FIDELIDADE 30%;
- ORDEM DAS CONTEMPLAÇÕES A PARTIR DA 13ª ASSEMBLEIA:
SORTEIO;
SORTEIO;
LANCE FIDELIDADE 15%;
LANCE FIDELIDADE 30%;
- CONTEMPLAÇÕES CONDICIONADAS A EXISTÊNCIA DE SALDO NO GRUPO.
- LANCE FIDELIDADE 15% FIXO:
EXIGE 12 PARCELAS PAGAS EM DIA.`;

export function groupDetailsFixture(group = 9999) {
  const fields = {
    "Contemplados por sorteio": "2", "Contemplados por lance": "19", "Lance Embutido": "30,00%",
    "Número de consorciados": "5.040", "Vencimento dia": "16", "Próxima assembléia": "017 - 23/11/2026 - 16:00 HORAS",
    "Fundo reserva": "0,5000%", "Tipo de sorteio": "LOT. FEDERAL", "Tipo de seguro": "SEGURO NA CONTEMPLACAO",
    "Taxa de seguro": "0,0400%", "Tipo de grupo": "UNICO (LANCE DILUIDO)",
    "Previsão para o próximo reajuste (sujeito a alteração em caso de gatilho para o índice)": "24/01/2027",
  };
  const table = (headers: string[], cells: (string | number)[], attrs = "") =>
    `<table><thead><tr>${headers.map((s) => `<th>${s}</th>`).join("")}</tr></thead><tbody><tr ${attrs}>${cells.map((s) => `<td>${s}</td>`).join("")}</tr></tbody></table>`;
  return `<main class="main-view-container"><h3>Informações do Grupo: ${group}</h3><div class="grupo-info"><div class="pre-message">${groupRulesFixture.replace(/\n/g, "<br>")}</div>
    <table><tbody>${Object.entries(fields).map(([k, v]) => `<tr><td>${k}:</td><td>${v}</td></tr>`).join("")}</tbody></table></div>
    <div class="tabs"><a>Taxa de Adm - 12,00%</a></div>
    ${table(["Categoria", "Descrição", "Valor do Crédito", "Prazo", "% Mensal", "Parcela (Sem Seguro)", "Seguro", "Observação", "Total (Parcela + Seguro)", ""],
      ["A1", "Crédito fixture", "266.756,00", 224, "0,5603%", "1.494,63", "133,91", "SEGURO", "1.628,54", "Vender"],
      `data-url="/vendas/vendas-consorcio/0/${group}/S/A1/fixture/240/224"`)}
    ${table(["Assembléia", "Data", "Local", "Cidade", "Situação", "Visualizar"], [17, "23/11/2026 - 16:00h", "LOCAL", "CIDADE", "A realizar", "Visualizar"])}</main>`;
}
