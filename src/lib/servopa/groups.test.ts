import test from "node:test";
import assert from "node:assert/strict";
import { parseGroupDetails, parseGroupListing, groupNumber } from "./groups.js";
import { parseGroupAssemblyRules, validateGroupAssemblyRules } from "./group-rules.js";
import { groupListingFixture, groupDetailsFixture, groupRulesFixture } from "../../../test-fixtures/groups.js";

test("group parser extracts structured phases, rates and calendar without retired columns", () => {
  const result = parseGroupDetails(groupDetailsFixture(), 9999);
  if (result.cadastro.status !== "ok") throw Error("Missing fixture data");
  assert.equal(result.cadastro.data.numero_consorciados, 5040);
  assert.equal(result.cadastro.data.percentual_seguro, 0.04);
  assert.equal(result.cadastro.data.proxima_assembleia_em, "2026-11-23T16:00:00-03:00");
  assert.equal("regras_texto" in result.cadastro.data, false);
  assert.equal("previsao_reajuste" in result.cadastro.data, false);
  if (result.taxas_administracao.status !== "ok") throw Error("Missing fixture rates");
  assert.deepEqual(result.taxas_administracao.data[0], {
    categoria: "A1", descricao: "Crédito fixture", percentual: 12,
    prazo_original_meses: 240, prazo_meses: 224, valor_credito: 266756,
  });
  if (result.regras_assembleias.status !== "ok") throw Error("Missing fixture rules");
  assert.deepEqual(result.regras_assembleias.data.map((r) => [r.assembleia_inicio, r.assembleia_fim]), [[1, 6], [7, 12], [13, null]]);
  assert.equal(result.regras_assembleias.data[1].modalidades.filter((m) => m.tipo === "SORTEIO").length, 2);
  assert.ok(result.regras_assembleias.data[0].observacoes.some((s) => s.includes("CONFORME SALDO")));
  assert.ok(result.regras_assembleias.data[2].observacoes.some((s) => s.includes("12 PARCELAS")));
  assert.equal(parseGroupListing(groupListingFixture(), 9999).vagas_disponiveis, 1018);
  assert.throws(() => parseGroupDetails(groupDetailsFixture(), 9998), /confirm group/);
  assert.throws(() => groupNumber("1,2oops"), /numeric/);
});

test("unrecognized phases, percentages and modalities fail without erasing other sections", () => {
  const malformed = parseGroupDetails(groupDetailsFixture().replace("266.756,00", "--")
    .replace("23/11/2026 - 16:00h", "31/02/2026 - 16:00h").replace("FIDELIDADE 30%", "FIDELIDADE ESPECIAL"), 9999);
  assert.equal(malformed.taxas_administracao.status, "falha");
  assert.equal(malformed.assembleias.status, "falha");
  assert.equal(malformed.regras_assembleias.status, "falha");
  assert.equal(malformed.cadastro.status, "ok");
  assert.throws(() => parseGroupAssemblyRules("Regra desconhecida"), /initial assembly phase/);
  assert.throws(() => parseGroupAssemblyRules(groupRulesFixture.replace("7ª", "8ª")), /Overlapping or incomplete/);
  assert.throws(() => parseGroupAssemblyRules(groupRulesFixture.replace("30%", "130%")), /percentage/);
  assert.throws(() => validateGroupAssemblyRules([{ assembleia_inicio: 7 }]), /Invalid structured/);
});

test("phase boundaries, free bids and fixed bids retain their distinct meanings", () => {
  const rules = parseGroupAssemblyRules(`- ORDEM DAS CONTEMPLAÇÕES ATE A 12ª ASSEMBLEIA:
SORTEIO;
LANCE FIXO 30%;
LANCE LIVRE SEM EMBUTIDO;
LANCE LIVRE COM EMBUTIDO 30%.
- ORDEM DAS CONTEMPLAÇÕES APARTIR DA 13ª ASSEMBLEIA:
SORTEIO;
LANCE FIDELIDADE DE 20% FIXO;
- ORDEM DAS CONTEMPLAÇÕES A PARTOR DA 19ª ASSEMBLEIA:
SORTEIO;
LANCE FIDELIDADE 10%;`);
  assert.deepEqual(validateGroupAssemblyRules(rules).map((r) => [r.assembleia_inicio, r.assembleia_fim]), [[1, 12], [13, 18], [19, null]]);
  assert.deepEqual(rules[0].modalidades[3], { ordem: 4, tipo: "LIVRE", percentual: null, embutido: true, percentual_embutido: 30 });
  assert.equal(rules[0].modalidades[1].tipo, "FIXO");
  const invalid = structuredClone(rules);
  invalid[1].modalidades[1].percentual = null;
  assert.throws(() => validateGroupAssemblyRules(invalid), /Inconsistent/);
});
