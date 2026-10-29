import assert from "node:assert/strict";
import test from "node:test";
import { idempotencyKeys } from "@trigger.dev/sdk";
import { runScheduledBids, runScheduledOffers, runScheduledGroups } from "../trigger/monthly-schedules.js";
import { submitBid } from "../trigger/submit-bid.js";
import { offerReminder } from "../trigger/offer-reminder.js";
import { groupsSync } from "../trigger/groups-sync.js";

test("scheduled group sync discovers all groups on days 1 and 15 and rejects stale runs", async (t) => {
  const keys = t.mock.method(idempotencyKeys, "create", async (key: string) => key);
  const child = t.mock.method(groupsSync, "triggerAndWait", () => ({ unwrap: async () => "fixture-result" }));
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-01T10:00:00Z") });
  for (const day of ["01", "15"]) {
    const date = `2026-11-${day}`;
    const timestamp = new Date(`${date}T10:00:00Z`);
    t.mock.timers.setTime(timestamp.getTime());
    assert.equal(await runScheduledGroups({ timestamp }), "fixture-result");
    const [payload, options] = child.mock.calls.at(-1)!.arguments;
    assert.deepEqual(payload, {});
    assert.equal(options?.idempotencyKey, `scheduled-groups-sync:${date}`);
    assert.equal(options?.maxAttempts, 1);
    assert.deepEqual(keys.mock.calls.at(-1)!.arguments[1], { scope: "global" });
  }
  await assert.rejects(runScheduledGroups({ timestamp: new Date("2026-11-01T10:00:00Z") }), /intended date/);
  assert.equal(child.mock.callCount(), 2);
});

test("scheduled bids select only the matching payment day and keep one child per date", async (t) => {
  const keys = t.mock.method(idempotencyKeys, "create", async (key: string) => key);
  const child = t.mock.method(submitBid, "triggerAndWait", () => ({ unwrap: async () => "fixture-result" }));
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-06T12:00:00Z") });
  for (const [day, dtVenc] of [[6, 8], [14, 16], [18, 20]]) {
    const date = `2026-11-${String(day).padStart(2, "0")}`;
    const timestamp = new Date(`${date}T12:00:00Z`);
    t.mock.timers.setTime(timestamp.getTime());
    assert.equal(await runScheduledBids({ timestamp }), "fixture-result");
    const [payload, options] = child.mock.calls.at(-1)!.arguments;
    assert.deepEqual(payload, { dtVenc, asOfDate: date, respectIdempotency: true });
    assert.equal(options?.maxAttempts, 1);
    assert.equal(options?.idempotencyKey, `scheduled-submit-bid:${date}`);
    assert.deepEqual(keys.mock.calls.at(-1)!.arguments[1], { scope: "global" });
  }
  assert.equal(child.mock.callCount(), 3);
});

test("scheduled offers use days 1 and 15 with independent date keys and propagate failures", async (t) => {
  t.mock.method(idempotencyKeys, "create", async (key: string) => key);
  const child = t.mock.method(offerReminder, "triggerAndWait", () => ({ unwrap: async () => "fixture-result" }));
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-01T12:00:00Z") });
  for (const day of ["01", "15"]) {
    const date = `2026-11-${day}`;
    const timestamp = new Date(`${date}T12:00:00Z`);
    t.mock.timers.setTime(timestamp.getTime());
    await runScheduledOffers({ timestamp });
    const [payload, options] = child.mock.calls.at(-1)!.arguments;
    assert.deepEqual(payload, { asOfDate: date, respectIdempotency: true });
    assert.equal(options?.idempotencyKey, `scheduled-offers:${date}`);
  }
  child.mock.mockImplementation(() => ({ unwrap: async () => { throw new Error("child failed"); } }));
  await assert.rejects(runScheduledOffers({ timestamp: new Date() }), /child failed/);
});

test("old, invalid and off-calendar timestamps cannot trigger financial or messaging tasks", async (t) => {
  const bids = t.mock.method(submitBid, "triggerAndWait", () => { throw new Error("Unexpected bid"); });
  const offers = t.mock.method(offerReminder, "triggerAndWait", () => { throw new Error("Unexpected offer"); });
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-06T12:00:00Z") });
  await assert.rejects(runScheduledBids({ timestamp: new Date("2026-10-06T12:00:00Z") }), /intended date/);
  await assert.rejects(runScheduledBids({ timestamp: new Date("invalid") }), /valid schedule timestamp/);
  await assert.rejects(runScheduledOffers({ timestamp: new Date() }), /intended date/);
  // UTC is already day 6; Sao Paulo is still day 5.
  t.mock.timers.setTime(new Date("2026-11-06T01:00:00Z").getTime());
  await assert.rejects(runScheduledBids({ timestamp: new Date() }), /intended date/);
  assert.equal(bids.mock.callCount(), 0);
  assert.equal(offers.mock.callCount(), 0);
});
