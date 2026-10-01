# Servopa Trigger refactor checklist

This checklist is the acceptance contract for the cleanup. Keep functionality
stable unless a check below explicitly fixes unsafe behavior.

## Phase 0 — safety first

- [ ] Rotate the exposed Servopa credential.
- [x] Remove hard-coded credentials from source.
- [ ] Remove customer exports from the workspace.
- [x] Remove real callback/token URLs from source and logs.
- [x] Remove experimental test tasks from `src/trigger` before the next deploy.
- [x] Validate date and bid filter payloads at their boundary; malformed filters fail closed.
- [ ] Validate every remaining task payload at its boundary.
- [x] Require an explicit approved callback before submitting a bid.
- [x] Add concurrency protection for reminder sends and bid submissions.
- [x] Add a guard against mass customer inactivation from incomplete source data.

## Phase 1 — trustworthy checks

- [x] `npm run check` runs the complete maintained type-check and test suite.
- [x] Deployable Trigger files are type-checked; no deprecated `/v3` imports remain.
- [x] `noUnusedLocals` and `noUnusedParameters` pass.
- [x] Documentation matches the source schedule and D1/D7/D14 rules.

## Phase 2 — deterministic workflow execution

- [ ] Every workflow has a pure planning step that accepts an explicit `asOfDate`.
- [x] Fixture dry runs perform zero Supabase writes, Z-API sends, bid registrations,
      callback creation, or report generation.
- [x] One scheduled daily orchestrator runs synchronization before dependent workflows.
- [x] Child workflows are callable tasks without duplicate schedules.
- [ ] Live previews may read required sources but cannot perform mutations.
- [x] A single CLI supports workflow, date, and fixture selection for overdue and bid prechecks.
- [ ] A failed/skipped customer can be retried after the underlying problem is fixed.

## Phase 3 — behavior coverage

- [ ] Birthday CPF dedupe works across formatting variants and both Supabase bases.
- [ ] Birthday phone selection is deterministic and falls back through non-empty values.
- [x] `cd_whatsapp` is preserved when filled and backfilled from the site phone only when empty.
- [x] Overdue D1, D7, D14, and every-14-day repeats are covered by date tests.
- [ ] Payment and overdue boleto selection covers single, dilution, latest, and missing cases.
- [ ] Sync parsers cover malformed, empty, and partial reports.
- [ ] Bid preview, rejection, approval, duplicate, and partial-failure paths are covered.
- [ ] Active-customer verification has dry-run, invalid-date, empty-source, and mass-change tests.

## Phase 4 — simplify the tree

- [x] Retire the one-time overdue bootstrap after confirming there are no callers.
- [x] Replace one-off scripts with the maintained workflow CLI and fixtures.
- [x] Merge duplicated Supabase transport code and tiny utility modules.
- [ ] Share boleto selection, button creation, and reminder result handling.
- [x] Remove `cycletls` if no maintained code uses it.
- [ ] Re-audit dependencies after the Trigger SDK upgrade.

## Required gates after each code change

```text
npm run check
npm run workflow -- <workflow> --date <YYYY-MM-DD> --fixture <fixture>
```

The dry-run gate is not complete unless its output proves that send, write,
registration, and callback side-effect counters are all zero.
