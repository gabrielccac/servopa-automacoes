# Project Context

## Overview

This project is a Trigger.dev-based automation app for Servopa-related workflows.

The current focus is on two major areas:

- daily data sync from Servopa into Supabase
- reminder workflows that read Supabase, optionally validate with Servopa, send WhatsApp messages through Z-API, and persist outcomes to `reminder_logs`

The codebase is intentionally being built workflow-first. We prefer getting the real business flow working end to end, then extracting shared helpers only when patterns become obvious.

## Main Integrations

### Trigger.dev

- Tasks live in `src/trigger/`
- We currently prefer normal task orchestration over child-task fanout when a workflow depends on shared session state
- Long-running customer loops should log progress in coarse checkpoints, not per-customer spam

### Supabase

- Supabase REST helpers live in `src/lib/supabase/`
- Main tables currently in use:
  - `bd_producao`
  - `inadimplentes`
  - `resultado_ultimas_assembleias`
  - `disponivel_para_vender`
  - `reminder_logs`
- `reminder_logs` stores final reminder outcomes and is used for rerun filtering
- Filtering of already processed reminders is currently done in code after fetching `reminder_logs`

### Servopa

- The Servopa HTTP client is `src/lib/http-client.ts`
- Uses `createSession` from `wreq-js` with profile: `firefox_149` + `windows`
- Forced HTTP/2 via `emulation.tlsOptions.alpnProtocols: ["HTTP2"]` — HTTP/1.1 consistently gets Cloudflare 403
- pt-BR locale headers (`Accept-Language`) set through `emulation.headers` for realistic Brazilian browser fingerprint
- Important constraint: one PHP session effectively carries one active customer context at a time
- Because of that, Servopa-dependent customer workflows should run sequentially in one task with one login per run
- Avoid concurrent customer processing with the same session

#### Matrix Login Test Results

- Task `src/trigger/test-matrix-login.ts` tested 22 browser/OS/ALPN combinations
- Findings:
  - **HTTP/2 is essential** — every HTTP/1.1 config got Cloudflare 403 ("Just a moment...")
  - **Chrome 142 (latest) always blocked** — Cloudflare fingerprint catches it regardless of OS/HTTP
  - **OkHttp always blocked** — non-browser fingerprint rejected entirely
  - **Linux inconclusive** — only tested with HTTP/1.1
  - Working profiles: Firefox, Safari, Edge, Opera all work with HTTP/2
- Test task `src/trigger/test-raw-proxy-login.ts` exists for proxy-based login testing

### Z-API

- Z-API helpers live in `src/lib/whatsapp/zapi.ts`
- Supported send modes currently used:
  - plain text
  - button actions
- Delivery webhook work was explored, but is not part of the current production flow
- Execution summaries send to the phone configured in `ZAPI_EXECUTION_SUMMARY_PHONE`

## Current Workflow Strategy

### General Rule

Prefer:

- one workflow task
- optional payload override for targeted tests
- `dryRun` support
- DB mode by default when payload is absent

Avoid:

- child tasks for session-bound Servopa flows
- excessive abstraction before a pattern is proven

### Payload Pattern

Reminder tasks should support:

- no payload: run against DB
- single customer object
- array of customer objects
- object form with `customer` or `customers`
- optional `dryRun`

`dryRun: true` means:

- process normally
- do not send messages
- do not persist reminder logs

Payload runs intentionally bypass the reminder-log prefilter so specific customers can be force-tested. They can opt back into dedupe with `respectIdempotency: true`.

## Daily Sync

### Task

- `src/trigger/daily-sync.ts`

### Current Behavior

The daily sync is now implemented for all 4 source files:

1. Inadimplentes PDF
2. `RESULTADO_ULTIMAS_ASSEMBLEIAS.csv`
3. `DISPONIVEL_PARA_VENDER.csv`
4. `BD_PRODUCAO.csv`

Flow:

- login to Servopa once
- discover file metadata from:
  - `/vendas/relatorios-inadimplentes`
  - `/vendas/diversos`
  - `/vendas/downloads`
- if today’s `BD_PRODUCAO` does not exist yet, trigger generation and poll until it appears
- download file contents
- sync each file into Supabase

### Per-file Sync Rules

#### `BD_PRODUCAO.csv`

- parsed from CSV into normalized records
- upserted into `bd_producao`
- conflict key: `nr_contrato`
- direct field mapping with type normalization only

Important note:

- do **not** overwrite `cd_whatsapp`
- provider phone is mapped only to `cd_cel_consorciado`
- `cd_whatsapp` is intentionally curated separately in DB

#### `RESULTADO_ULTIMAS_ASSEMBLEIAS.csv`

- parsed from CSV into normalized records
- bulk POST to `resultado_ultimas_assembleias`
- uses `Prefer: resolution=merge-duplicates`
- treated as direct upsert/merge behavior like the old n8n implementation

#### `DISPONIVEL_PARA_VENDER.csv`

- parsed from CSV into normalized records
- full replace behavior:
  - delete current table contents
  - insert fresh rows
- also writes `dt_snapshot = today` in Sao Paulo ISO date format

#### Inadimplentes PDF

- parsed with `src/lib/pdf-parser.ts`
- synced into `inadimplentes` with overdue-cycle logic

Cycle behavior:

- if contract appears in PDF and no active row exists:
  - insert new row
  - set `dt_primeira_ocorrencia = today`
  - set `dt_ultima_ocorrencia = today`
  - set `st_ativo = true`
- if contract appears in PDF and active row exists:
  - update that row
  - keep `dt_primeira_ocorrencia`
  - refresh PDF-derived fields
  - set `dt_ultima_ocorrencia = today`
  - keep `st_ativo = true`
- if contract was active in DB but does not appear in today’s PDF:
  - mark row `st_ativo = false`
  - keep `dt_ultima_ocorrencia` as the last day it was actually seen

This means:

- overdue history is preserved
- if a customer leaves the PDF and comes back later, a new active cycle is created
- reminder cadence can restart cleanly from D1

### `inadimplentes` Table Assumptions

Current expected shape includes:

- `id`
- `nr_contrato`
- `nr_cota`
- `nm_consorciado`
- `cd_celular`
- `dt_vc`
- `qt_pgo`
- `qt_atr`
- `vl_percent_mensal`
- `vl_percent_difer`
- `vl_atraso`
- `dt_primeira_ocorrencia`
- `dt_ultima_ocorrencia`
- `st_ativo`

Important design:

- primary key should be surrogate `id`
- `nr_contrato` is not the primary key anymore
- there can be multiple historical rows for the same contract
- only one active cycle per contract should exist at a time

## Reminder Workflows

### Payment Reminder

Task:

- `src/trigger/payment-reminder.ts`

Behavior:

- fetches active customers from `bd_producao`
- filters by due date
- logs into Servopa once
- processes customers sequentially
- confirms customer context through contract match
- parses boleto/payment info from `/vendas/extrato`
- customer is eligible only when `boletos.length > 0`
- sends WhatsApp via Z-API
- writes final outcome to `reminder_logs`

Current reminder type:

- `payment_due_d1`

Current send rule:

- choose the boleto with the highest `nr_parcela`
- from that selected boleto:
  - if both `boleto_url` and `pix_url` exist, send both buttons
  - if only one exists, send the one available
  - if no URL exists, fall back to plain text

Current reminder-log filter on normal DB runs:

- exclude existing `sent`
- exclude existing `skipped`
- retry `failed`
- include customers with no log yet

Current completion summary:

- inline in the task itself
- only sends when `dryRun` is false and there was at least one sent message or one error
- current wording:
  - `Clientes com vencimento dia {reference date}`
  - `Clientes com boleto em aberto`
  - `Mensagens enviadas`
  - `Clientes sem boleto pendente`
  - `Erros`

### Overdue Payment Reminder

Task:

- `src/trigger/overdue-payment-reminder.ts`

Behavior:

- fetches rows from `inadimplentes`
- only considers rows where `st_ativo = true` in practice because the workflow checks `dt_ultima_ocorrencia = today`
- keeps only customers whose `dt_ultima_ocorrencia` is today
- currently sends only on milestone days:
  - day 1
  - day 7
  - day 15
- logs into Servopa once
- processes customers sequentially
- confirms customer context through contract match
- parses boleto/payment info from `/vendas/extrato`
- if `boletos.length === 0`, customer is `skipped`
- otherwise selects one boleto target and sends WhatsApp
- writes final outcome to `reminder_logs`

Current overdue boleto send rule:

- if there is exactly 1 boleto open, send that one
- if there are multiple boletos and one is diluicao, send the diluicao boleto
- otherwise send the latest boleto by highest `nr_parcela`
- if the selected boleto has both `boleto_url` and `pix_url`, send both buttons
- if it has only one, send the one available
- if it has no URLs, fall back to plain text

Current overdue message rule:

- template varies by stage:
  - D1
  - D7
  - D15
- when the selected boleto comes from a multi-pendency case, append the extra advisory about other pendencies and contacting the team

Current completion summary:

- inline in the task itself
- only sends when `dryRun` is false and there was at least one sent message or one error
- current wording:
  - `Clientes analisados com pendencia`
  - `Clientes com boleto em aberto`
  - `Mensagens enviadas`
  - `Clientes sem boleto pendente`
  - `Erros`

Important pending item:

- recurring overdue cycle after D15 is not implemented yet
- intended rule:
  - after D15, send again every 30 days from `dt_primeira_ocorrencia`

### Birthday Reminder

Task:

- `src/trigger/birthday-reminder.ts`

Behavior:

- pulls active customers from `bd_producao`
- matches birthday by month/day only
- sends plain text only
- writes `sent` or `failed` to `reminder_logs`

Current reminder type:

- `birthday`

Important note:

- birthday reminder is currently still contract-based because `reminder_logs` uses `nr_contrato`
- if one person has multiple contracts, they may receive multiple birthday sends
- grouping by `cd_whatsapp` is a possible future enhancement, but is not active now

Current completion summary:

- inline in the task itself
- only sends when `dryRun` is false and there was at least one sent message or one error
- current wording:
  - `Clientes aniversariantes {today}`
  - then list customer first names, one per line
  - `Erros`

### Contemplation Reminder

Task:

- `src/trigger/contemplation-reminder.ts`

Behavior:

- pulls active customers from `bd_producao`
- matches `dt_contemplacao` to today
- sends plain text only
- writes `sent` or `failed` to `reminder_logs`

Current reminder type:

- `contemplation`

Current completion summary:

- inline in the task itself
- only sends when `dryRun` is false and there was at least one sent message or one error
- current wording:
  - `Clientes contemplados {today}`
  - then list customer first names, one per line
  - `Erros`

## Message and Template Rules

Shared message builders live in:

- `src/lib/whatsapp/templates.ts`

Important name rule for customer-facing messages:

- always use first name only
- first letter uppercase
- rest lowercase

Examples:

- `JOAO SILVA` -> `Joao`
- `mArIa eduarda` -> `Maria`

This rule currently applies to:

- payment reminder messages
- overdue payment reminder messages
- birthday reminder messages
- contemplation reminder messages
- birthday summary customer list
- contemplation summary customer list

## `reminder_logs` Table

Current intended lean shape:

- `id`
- `idempotency_key`
- `nr_contrato`
- `nm_consorciado`
- `cd_whatsapp`
- `reminder_type`
- `reference_date`
- `status`
- `message_body`
- `external_message_id`
- `last_error`
- `sent_at`
- `created_at`
- `updated_at`

Purpose:

- deduplicate recurring reminders
- support rerun filtering
- keep a lightweight communication history

Important note:

- `nr_contrato` may appear many times across the table
- the table is one-to-many from customer/contract to reminder events

## Coding Patterns We’ve Been Using

### 1. Workflow-first implementation

We usually:

- implement the real workflow first
- validate it with targeted tests
- extract shared helpers only after repetition becomes obvious

### 2. Keep business logic explicit

We prefer code that makes business decisions easy to inspect.

Examples:

- explicit eligibility checks
- explicit boleto selection rules
- explicit rerun filtering
- explicit send-mode rules
- explicit cycle state transitions

### 3. Shared-session Servopa flows stay sequential

If a workflow sets customer context on Servopa:

- login once
- process one customer fully
- move to the next customer
- logout at the end

Do not split this into concurrent child tasks using the same session.

### 4. Coarse progress logs

Use checkpoint logs like:

- first processed
- every N processed
- final processed

Avoid noisy per-customer logs unless debugging a specific issue.

### 5. Final result output should be compact

Workflow output should favor:

- counts
- summarized results
- key fields only

Avoid returning huge internal objects unless explicitly needed for debugging.

### 6. `skipped` vs `failed`

Use:

- `skipped` for intentional non-send cases
- `failed` for actual errors

### 7. Use payload mode for testing

Instead of creating many one-off scenario folders or highly duplicated test code:

- let the real task accept a payload
- use `dryRun` when safe testing is needed

## Important Files

- `src/lib/http-client.ts`
  Servopa login/session HTTP client
- `src/lib/customer-due-date.ts`
  customer context activation and due-date extraction
- `src/lib/customer-payment-info.ts`
  Servopa extrato parsing with Cheerio
- `src/lib/csv.ts`
  simple semicolon CSV parsing
- `src/lib/pdf-parser.ts`
  inadimplentes PDF parsing
- `src/lib/supabase/client.ts`
  generic Supabase REST helpers
- `src/lib/supabase/utils.ts`
  customer fetch helpers
- `src/lib/supabase/reminder-logs.ts`
  reminder log fetch/upsert helpers
- `src/lib/supabase/daily-sync.ts`
  daily sync mapping and Supabase write logic
- `src/lib/whatsapp/templates.ts`
  shared reminder message builders and name formatting
- `src/lib/whatsapp/zapi.ts`
  Z-API integration
- `src/trigger/daily-sync.ts`
  Servopa daily file sync
- `src/trigger/payment-reminder.ts`
  payment due D-1 workflow
- `src/trigger/overdue-payment-reminder.ts`
  overdue payment workflow
- `src/trigger/birthday-reminder.ts`
  birthday workflow
- `src/trigger/contemplation-reminder.ts`
  contemplation workflow
- `src/trigger/test-matrix-login.ts`
  login matrix test (browser/OS/ALPN combos)
- `src/trigger/test-raw-proxy-login.ts`
  proxy-based login test

## Tasks Still To Implement

- add recurring overdue reminder cycle after D15
  intended rule:
  - after D15, send every 30 days from `dt_primeira_ocorrencia`
- if needed later, consider whether birthday should eventually dedupe/group by `cd_whatsapp` instead of remaining contract-based

## Things To Remember In Future Sessions

- Payment reminder is contract-based, not person-based
- Birthday reminder is also currently contract-based
- Payload runs bypass reminder-log filtering on purpose unless `respectIdempotency: true`
- `dryRun` does not send and does not persist reminder logs
- Servopa parsing should use proper HTML parsing, not fragile regex-only extraction, when page structure matters
- For customer payment info, an HTTP `200` alone is not enough; customer context must also be confirmed via contract match
- If future reminder workflows do not depend on Servopa session state, they can be simpler than payment reminder
- The old shared completion-summary helper was removed; summaries now live inside each workflow
- HTTP/1.1 always gets Cloudflare 403 from Servopa; always use HTTP/2 via `emulation.tlsOptions.alpnProtocols: ["HTTP2"]`
- Chrome 142 (latest) and OkHttp profiles are blocked by Cloudflare; use Firefox, Safari, Edge, or Opera instead
- The `SUPABASE_URL` env var should be just the base URL (`https://xxx.supabase.co`) — do NOT include `/rest/v1/` in it
