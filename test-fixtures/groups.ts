export function groupListingFixture(group = 9999) {
  return `<table><thead><tr>${["Grupo", "Segmento", "Meses", "AssemblÃ©ia", "Lance", "Contemplados", "Vagas", "Visualizar"].map((s) => `<th>${s}</th>`).join("")}</tr></thead>
  <tbody><tr>${[group, "I", 240, 17, 0, 0, "1.018", "Visualizar"].map((s) => `<td>${s}</td>`).join("")}</tr></tbody></table>`;
}
export function groupDetailsFixture(mode = "SEM EMBUTIDO", group = 9999) {
  const fields = {
    "Contemplados por sorteio": "2", "Contemplados por lance": "19", "Lance Embutido": "30,00%",
    "NÃºmero de consorciados": "5.040", "Vencimento dia": "16", "PrÃ³xima assemblÃ©ia": "017 - 23/11/2026 - 16:00 HORAS",
    "Fundo reserva": "0,5000%", "Tipo de sorteio": "LOT. FEDERAL", "Tipo de seguro": "SEGURO NA CONTEMPLACAO",
    "Taxa de seguro": "0,0400%", "Tipo de grupo": "UNICO (LANCE DILUIDO)",
    "PrevisÃ£o para o prÃ³ximo reajuste (sujeito a alteraÃ§Ã£o em caso de gatilho para o Ã­ndice)": "24/01/2027",
  };
  const table = (headers: string[], cells: (string | number)[], attrs = "") =>
    `<table><thead><tr>${headers.map((s) => `<th>${s}</th>`).join("")}</tr></thead><tbody><tr ${attrs}>${cells.map((s) => `<td>${s}</td>`).join("")}</tr></tbody></table>`;
  return `<main class="main-view-container"><h3>InformaÃ§Ãµes do Grupo: ${group}</h3><div class="grupo-info"><div class="pre-message">Regra A<br>Regra B</div>
    <table><tbody>${Object.entries(fields).map(([k, v]) => `<tr><td>${k}:</td><td>${v}</td></tr>`).join("")}</tbody></table></div>
    <div class="tabs"><a>Taxa de Adm - 12,00%</a></div>
    ${table(["Categoria", "DescriÃ§Ã£o", "Valor do CrÃ©dito", "Prazo", "% Mensal", "Parcela (Sem Seguro)", "Seguro", "ObservaÃ§Ã£o", "Total (Parcela + Seguro)", ""],
      ["A1", "CrÃ©dito fixture", "266.756,00", 224, "0,5603%", "1.494,63", "133,91", "SEGURO", "1.628,54", "Vender"],
      `data-url="/vendas/vendas-consorcio/0/${group}/S/A1/fixture/240/224"`)}
    ${table(["AssemblÃ©ia", "Data", "Local", "Cidade", "SituaÃ§Ã£o", "Visualizar"], [17, "23/11/2026 - 16:00h", "LOCAL", "CIDADE", "A realizar", "Visualizar"])}
    ${table(["AssemblÃ©ia", "Data", "Maior Lance", "Menor Lance", "Tipo", "Quantidade"], [1, "14/05/26", "0%", "0%", mode, 0])}</main>`;
}
