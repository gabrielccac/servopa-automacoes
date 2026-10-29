import assert from "node:assert/strict";
import test from "node:test";
import { getNextOfferStep, offerPrecheck, parseGroupOfferHierarchy } from "./offer-policy.js";

test("group hierarchies distinguish Fixo from Fidelidade and recognize all group percentages", () => {
  assert.deepEqual(parseGroupOfferHierarchy(1, "LANCE FIXO 30%; LANCE FIDELIDADE DE 15% FIXO").hierarquia_fidelidade, [15]);
  assert.deepEqual(parseGroupOfferHierarchy(2, "LANCE FIDELIDADE 30%; LANCE FIDELIDADE DE\n20%; LANCE FIDELIDADE DE 10%; LANCE FIDELIDADE 30%").hierarquia_fidelidade, [30, 20, 10]);
  assert.deepEqual(parseGroupOfferHierarchy(3, "LANCE FIXO; LANCE LIVRE COM EMBUTIDO 30%").hierarquia_fidelidade, []);
  assert.ok(parseGroupOfferHierarchy(4, null).erro);
  assert.ok(parseGroupOfferHierarchy(5, "LANCE FIDELIDADE ESPECIAL").erro);
  assert.ok(parseGroupOfferHierarchy(6, "LANCE FIDELIDADE 120%").erro);
});

test("offers require a known current state and a better option in that group's hierarchy", () => {
  const options = [10, 15, 20, 30].map((pct_lance) => ({ lance_type: "FIDELIDADE" as const, pct_lance }));
  const current = { tp_lance: "FIDELIDADE", pct_lance: 30 };
  assert.equal(getNextOfferStep(current, options, [30, 20, 10])?.pctLance, 10);
  assert.equal(getNextOfferStep(current, options, [30, 15])?.pctLance, 15);
  assert.equal(getNextOfferStep(current, options.filter((o) => o.pct_lance !== 10), [30, 20, 10])?.pctLance, 20);
  assert.equal(getNextOfferStep({ tp_lance: "FIDELIDADE", pct_lance: 10 }, options, [30, 20, 10]), null);
  assert.equal(getNextOfferStep(null, options, [30, 20, 10]), null);
  assert.equal(getNextOfferStep({ tp_lance: "FIXO", pct_lance: 30 }, options, [15])?.pctLance, 15);
  assert.equal(getNextOfferStep(current, options.filter((o) => o.pct_lance === 15), [30, 20, 10]), null);
  assert.equal(offerPrecheck(current, undefined), "group_rules_unavailable");
  assert.equal(offerPrecheck(current, { nr_grupo: 1, hierarquia_fidelidade: [] }), "group_has_no_fidelidade");
  assert.equal(offerPrecheck({ tp_lance: "FIDELIDADE", pct_lance: 15 }, { nr_grupo: 1, hierarquia_fidelidade: [30, 20, 10] }), "current_lance_not_in_group_hierarchy");
});
