import { AbortTaskRunError, idempotencyKeys, logger, schedules } from "@trigger.dev/sdk";
import { getTodayIsoDateInSaoPaulo } from "../lib/supabase/customers.js";
import { offerReminder } from "./offer-reminder.js";
import { submitBid } from "./submit-bid.js";

function scheduledDate(timestamp: Date, days: number[]): string {
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    throw new AbortTaskRunError("A valid schedule timestamp is required");
  }
  const date = getTodayIsoDateInSaoPaulo(timestamp);
  // Replays of an old cron must not submit a different month's bids or send stale offers.
  if (date !== getTodayIsoDateInSaoPaulo() || !days.includes(Number(date.slice(8)))) {
    throw new AbortTaskRunError("Schedule must run on its intended date in America/Sao_Paulo");
  }
  return date;
}

export async function runScheduledBids(payload: { timestamp: Date }) {
  const asOfDate = scheduledDate(payload.timestamp, [6, 14, 18]);
  const dtVenc = Number(asOfDate.slice(8)) + 2;
  logger.log("Scheduled bid batch", { asOfDate, dtVenc });
  return submitBid.triggerAndWait(
    { dtVenc, asOfDate, respectIdempotency: true },
    {
      idempotencyKey: await idempotencyKeys.create(`scheduled-submit-bid:${asOfDate}`, { scope: "global" }),
      idempotencyKeyTTL: "35d",
      maxAttempts: 1,
    },
  ).unwrap();
}

export async function runScheduledOffers(payload: { timestamp: Date }) {
  const asOfDate = scheduledDate(payload.timestamp, [1, 15]);
  logger.log("Scheduled offers", { asOfDate });
  return offerReminder.triggerAndWait(
    { asOfDate, respectIdempotency: true },
    {
      idempotencyKey: await idempotencyKeys.create(`scheduled-offers:${asOfDate}`, { scope: "global" }),
      idempotencyKeyTTL: "35d",
      maxAttempts: 1,
    },
  ).unwrap();
}

export const scheduledSubmitBid = schedules.task({
  id: "scheduled-submit-bid",
  cron: {
    pattern: "0 9 6,14,18 * *",
    timezone: "America/Sao_Paulo",
    window: "0m",
    environments: ["PRODUCTION"],
  },
  maxDuration: 900,
  retry: { maxAttempts: 1 },
  queue: { concurrencyLimit: 1 },
  run: runScheduledBids,
});

export const scheduledOffers = schedules.task({
  id: "scheduled-offers",
  cron: {
    pattern: "0 9 1,15 * *",
    timezone: "America/Sao_Paulo",
    window: "0m",
    environments: ["PRODUCTION"],
  },
  maxDuration: 900,
  retry: { maxAttempts: 1 },
  queue: { concurrencyLimit: 1 },
  run: runScheduledOffers,
});
