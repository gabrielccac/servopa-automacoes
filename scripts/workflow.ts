import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseAsOfDate } from "../src/lib/reminders/shared.js";
import { resolveReminderStage } from "../src/trigger/overdue-payment-reminder.js";
import { normalizeRequestedDtVenc } from "../src/trigger/submit-bid.js";

type JsonRecord = Record<string, unknown>;

function getPositionalArguments(): string[] {
  const args = process.argv.slice(2);
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument.startsWith("--")) {
      if (!argument.includes("=")) index += 1;
      continue;
    }
    positional.push(argument);
  }

  return positional;
}

function getOption(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function requireOption(name: string, positionalIndex: number): string {
  const value = getOption(name) ?? getPositionalArguments()[positionalIndex] ?? null;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readFixture(path: string): Promise<JsonRecord> {
  const value: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Fixture must contain a JSON object");
  }
  return value as JsonRecord;
}

function getCustomers(fixture: JsonRecord): JsonRecord[] {
  if (!Array.isArray(fixture.customers)) {
    throw new Error("Fixture must contain a customers array");
  }
  return fixture.customers.filter(
    (customer): customer is JsonRecord => Boolean(customer) && typeof customer === "object",
  );
}

function sideEffects() {
  return {
    supabaseWrites: 0,
    whatsappMessages: 0,
    bidRegistrations: 0,
    callbackTokens: 0,
    generatedReports: 0,
  };
}

async function main(): Promise<void> {
  const workflow = requireOption("--workflow", 0);
  const asOfDate = parseAsOfDate(requireOption("--date", 1));
  if (!asOfDate) throw new Error("--date is required");
  const fixture = await readFixture(requireOption("--fixture", 2));
  const customers = getCustomers(fixture);

  if (workflow === "overdue") {
    const planned = customers.map((customer) => ({
      contract: customer.nr_contrato ?? null,
      stage: resolveReminderStage(customer as never, asOfDate),
    }));

    console.log(JSON.stringify({
      workflow,
      mode: "fixture-dry-run",
      asOfDate,
      fetchedCount: customers.length,
      selectedCount: planned.filter((row) => row.stage !== null).length,
      planned,
      sideEffects: sideEffects(),
    }, null, 2));
    return;
  }

  if (workflow === "bid") {
    const requestedDtVenc = fixture.dtVenc === undefined
      ? null
      : normalizeRequestedDtVenc(fixture.dtVenc);
    if (fixture.dtVenc !== undefined && requestedDtVenc === null) {
      throw new Error("dtVenc must be a valid day of month between 1 and 31");
    }

    console.log(JSON.stringify({
      workflow,
      mode: "fixture-dry-run",
      asOfDate,
      fetchedCount: customers.length,
      requestedDtVenc,
      selectedCount: customers.length,
      sideEffects: sideEffects(),
    }, null, 2));
    return;
  }

  throw new Error(`Unsupported fixture workflow: ${workflow}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
