import test from "node:test";
import assert from "node:assert/strict";
import { parseGroupDetails, parseGroupHistory, parseGroupListing, groupNumber } from "./groups.js";

import { groupListingFixture, groupDetailsFixture } from "../../../test-fixtures/groups.js";

test("group parser validates identity, numeric formats and all mapped sections", () => {
  const result = parseGroupDetails(groupDetailsFixture(), 9999);
  assert.equal(result.cadastro.status, "ok");
  if (result.cadastro.status !== "ok") throw Error("Missing fixture data");
  assert.equal(result.cadastro.data.numero_consorciados, 5040);
  assert.equal(result.cadastro.data.percentual_seguro, 0.04);
  assert.equal(result.cadastro.data.proxima_assembleia_em, "2026-11-23T16:00:00-03:00");
  assert.equal(result.cadastro.data.regras_texto, "Regra A\nRegra B");
  assert.equal(result.planos.status, "ok");
  if (result.planos.status !== "ok") throw Error("Missing fixture plans");
  assert.equal(result.planos.data[0].prazo_original_meses, 240);
  assert.equal(result.planos.data[0].prazo_meses, 224);
  assert.equal(result.planos.data[0].taxa_administracao, 12);
  assert.equal(result.planos.data[0].valor_credito, 266756);
  assert.equal(result.historico_sem_embutido.status, "ok");
  if (result.historico_sem_embutido.status !== "ok") throw Error("Missing fixture history");
  assert.equal(result.historico_sem_embutido.data[0].quantidade, 0);
  assert.equal(result.historico_sem_embutido.data[0].data, "2026-05-14");
  assert.equal(parseGroupListing(groupListingFixture(), 9999).vagas_disponiveis, 1018);
  assert.throws(() => parseGroupDetails(groupDetailsFixture(), 9998), /confirm group/);
  assert.throws(() => parseGroupDetails("<html>Login</html>", 9999), /confirm group/);
  assert.throws(() => groupNumber("1,2oops"), /numeric/);
});

test("missing history, zero results, and malformed sections remain distinct", () => {
  const noHistory = `<main class="main-view-container"><h3>Informações do Grupo: 9999</h3>Histórico não encontrado para esta modalidade de lance!</main>`;
  assert.deepEqual(parseGroupHistory(noHistory, 9999, "sem_embutido"), { status: "sem_historico" });
  const malformed = parseGroupDetails(groupDetailsFixture().replace("266.756,00", "--").replace("23/11/2026 - 16:00h", "31/02/2026 - 16:00h"), 9999);
  assert.equal(malformed.planos.status, "falha");
  assert.equal(malformed.assembleias.status, "falha");
  assert.equal(malformed.cadastro.status, "ok");
  assert.equal(parseGroupHistory(groupDetailsFixture(), 9999, "com_embutido").status, "falha");
  assert.equal(parseGroupHistory(groupDetailsFixture("COM EMBUTIDO"), 9999, "com_embutido").status, "ok");
});
