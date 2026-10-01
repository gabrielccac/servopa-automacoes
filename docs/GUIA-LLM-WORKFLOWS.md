# Guia de workflows para o chat com LLM

Este documento é a fonte de contexto para responder perguntas sobre os workflows do sistema. Use-o para explicar regras e comportamento. Para perguntas sobre **um cliente, contrato, envio ou execução específicos**, consulte o plugin Supabase em modo somente leitura antes de concluir.

**Projeto Supabase:** `umvldqzzliqmgkvoedyd`.

## Regra para o chat

- Diferencie sempre **regra documentada** de **dado atual consultado no Supabase**.
- Quando o plugin Supabase tiver capacidade de consulta, use-o automaticamente para perguntas sobre casos específicos; não peça confirmação prévia e não peça que o cliente execute SQL.
- Nunca afirme que uma mensagem foi enviada sem consultar `reminder_logs` (e, quando disponível, o histórico de execuções).
- Nunca envie mensagens, altere dados ou execute tarefas por meio do chat do cliente.
- Não exponha CPF, e-mail, telefone ou credenciais sem necessidade.
- Se o registro não existir ou a informação não for suficiente, diga isso; não deduza.

### Quando o plugin Supabase não estiver disponível

Para perguntas sobre um cliente ou contrato específico, explique que a resposta depende de dados atuais e que não é possível confirmar o caso sem o plugin. O projeto a selecionar no plugin é `umvldqzzliqmgkvoedyd`. Não invente um resultado nem peça credenciais ou chaves. Quando o plugin estiver conectado e puder executar consultas, faça a consulta automaticamente. Só peça um identificador operacional mínimo, como número do contrato, se a busca por nome retornar mais de um cliente.

Resposta-modelo:

> Não consigo validar este caso porque a execução de consultas do Supabase não está disponível nesta conversa. Assim que ela estiver habilitada para o projeto `umvldqzzliqmgkvoedyd`, farei a consulta automaticamente e responderei com a causa.

### Consultas canônicas para investigação

Use os nomes reais das colunas; não invente `contrato`, `cliente`, `grupo` ou `cota`.

```sql
-- Buscar pelo nome do cliente
SELECT nr_contrato, nm_consorciado, nr_grupo, nr_cota,
       gp_fidelidade, dt_cancelamento, cd_whatsapp, nr_diavenc
FROM bd_producao
WHERE nm_consorciado ILIKE '%nome%';

-- Lance atual do contrato
SELECT nr_contrato, tp_lance, pct_lance
FROM lances
WHERE nr_contrato = '<contrato>';

-- Histórico de lembretes
SELECT reminder_type, reference_date, status, last_error, sent_at, created_at
FROM reminder_logs
WHERE nr_contrato = '<contrato>'
ORDER BY created_at DESC;
```

## Mapa de dados

| Tabela | Uso principal |
| --- | --- |
| `bd_producao` | Cadastro e situação das cotas: contrato, cliente, grupo, cota, telefone, vencimento, contemplação, `gp_fidelidade`, lance. |
| `inadimplentes` | Pendências de pagamento; o workflow de inadimplência considera somente `st_ativo = true`. |
| `reminder_logs` | Auditoria e idempotência de lembretes: `sent`, `skipped` e `failed`. |
| `lances` | Lance atual por contrato (`tp_lance`, `pct_lance`). |
| `bid_logs` | Auditoria de submissões de lance. |
| `bd_clientes` | Datas de nascimento usadas no lembrete de aniversário. |
| `clientes` | Fonte complementar de aniversariantes, quando configurada. |

## Ordem diária

1. `daily-sync` sincroniza os relatórios do Servopa com o Supabase.
2. `overdue-payment-reminder` roda depois da sincronização.
3. Os demais lembretes diários executam conforme seu próprio cron.

Os horários são definidos em UTC no Trigger.dev. Na configuração atual do repositório, `daily-sync` roda às 11:00 UTC (08:00 em São Paulo) e `overdue-payment-reminder` às 12:00 UTC (09:00 em São Paulo).

## 1. Sincronização diária (`daily-sync`)

**Objetivo:** atualizar a base local a partir dos relatórios do Servopa.

**Lê:** relatórios de inadimplência, `BD_PRODUCAO`, `BD_CLIENTES`, disponibilidade para venda e resultados de assembleias.

**Atualiza:** principalmente `bd_producao`, `bd_clientes` e `inadimplentes`.

**Efeito:** altera dados no Supabase. Não envia mensagem a clientes por si só.

**Perguntas que pedem consulta ao plugin:**

- “O cadastro do contrato X está atualizado?”
- “O cliente X está inadimplente agora?”
- “Quando foi o último pagamento?”

## 2. Lembrete de pagamento próximo do vencimento (`payment-reminder`)

**Objetivo:** avisar clientes cujo vencimento será em dois dias.

**Origem:** `bd_producao`, clientes ativos com `nr_diavenc` igual ao dia do mês de depois de amanhã.

**Validações:** consulta o Servopa para confirmar o contexto do cliente e obter boleto/Pix atual; exige telefone WhatsApp válido.

**Efeito:** envia WhatsApp com link de boleto e/ou Pix quando disponível e grava em `reminder_logs` com tipo `payment_due_d2`.

**Antiduplicação:** uma chave por contrato e data de vencimento; registros `sent` e `skipped` são tratados como finais.

## 3. Lembrete de inadimplência (`overdue-payment-reminder`)

**Objetivo:** cobrar somente cotas ainda inadimplentes.

**Origem:** `inadimplentes` com `st_ativo = true`.

**Regra de dias:** calcula dias corridos inclusivos desde `dt_primeira_ocorrencia`.

| Dia de inadimplência | Ação |
| --- | --- |
| 1 | Envia a primeira mensagem de pendência. |
| 7 | Envia o segundo lembrete. |
| 15 | Envia o terceiro lembrete. |
| 29, 43, 57… | Repete a mensagem do dia 15 a cada 14 dias enquanto `st_ativo` continuar verdadeiro. |

**Validações:** consulta o Servopa para confirmar boleto/Pix e situação de pagamento; exige telefone válido. Com mais de uma pendência, prioriza boleto de diluição; sem ele, prioriza a parcela mais recente.

**Efeito:** envia WhatsApp e grava em `reminder_logs` usando `overdue_payment_d1`, `overdue_payment_d7` ou `overdue_payment_d15`.

**Antiduplicação:** cada estágio e cada repetição quinzenal possui uma chave própria. Um log `sent` ou `skipped` evita novo envio da mesma etapa.

**Como investigar um caso:**

1. Busque o contrato em `inadimplentes`.
2. Confirme `st_ativo`, `dt_primeira_ocorrencia` e `dt_ultima_ocorrencia`.
3. Calcule o dia de inadimplência e veja se ele é 1, 7, 15 ou 15 + múltiplo de 14.
4. Consulte `reminder_logs` pelo contrato e pelos tipos `overdue_payment_*`.

## 4. Lembrete de aniversário (`birthday-reminder`)

**Objetivo:** enviar uma mensagem de aniversário no dia do aniversário.

**Origem:** `bd_producao` + `bd_clientes`; usa também `clientes` como fonte complementar quando configurada.

**Efeito:** envia WhatsApp e grava `birthday` em `reminder_logs`.

**Antiduplicação:** prefere CPF/CNPJ como identidade do aniversariante; se não existir, usa o contrato.

## 5. Lembrete de contemplação (`contemplation-reminder`)

**Objetivo:** avisar clientes contemplados no dia.

**Origem:** `bd_producao` com cliente ativo e `dt_contemplacao` igual à data atual.

**Efeito:** envia WhatsApp e grava `contemplation` em `reminder_logs`.

## 6. Análise de ofertas Fidelidade (`offer-reminder`)

**Objetivo:** identificar clientes aptos a receber uma oferta de lance Fidelidade.

**Origem:** `bd_producao` com cliente ativo, `gp_fidelidade = true`, contrato/cota/grupo preenchidos; consulta `lances` e opções atuais no Servopa.

**Regras:**

- Quem já está em Fidelidade 15% não é candidato.
- Quem está em lance Fixo pode receber Fidelidade 15%; se essa opção não existir, pode receber 30%.
- Quem está em Fidelidade 30% pode receber 15% quando esta opção existir.
- Sem lance atual, prioriza Fidelidade 15%; se não existir, usa 30%.
- Logs finais em `reminder_logs` impedem repetir uma oferta já registrada para contratos sem lance atual.

**Estado atual do código:** apenas lê dados e retorna candidatos, ignorados e erros. Ainda não envia WhatsApp ao cliente, não altera lance e não grava log.

**Comportamento planejado:** depois de identificar um candidato, o workflow enviará uma mensagem de oferta de lance Fidelidade e perguntará se o cliente deseja que o lance seja feito automaticamente. O envio será restrito aos clientes que não possuam lance automático já registrado em `lances`; a confirmação e o registro do lance continuarão sendo uma etapa separada.

**Template:** a mensagem de oferta ainda não existe em `src/lib/whatsapp/templates.ts`; ela será criada junto com a implementação do envio.

**Como investigar um caso:** consulte `bd_producao.gp_fidelidade`, `lances` e `reminder_logs`. Se `gp_fidelidade = false`, o cliente não entra na análise.

## 7. Sincronização de Fidelidade (`fidelidade-sync`)

**Objetivo:** preencher/atualizar os campos de Fidelidade em `bd_producao`.

**Efeito:** atualiza o Supabase; não envia WhatsApp.

## 8. Submissão de lance (`submit-bid`)

**Objetivo:** validar, simular, solicitar confirmação gerencial e, após confirmação, registrar lances.

**Dados:** consulta candidatos e opções no Servopa; usa `bid_logs` para evitar duplicidade mensal e `reminder_logs` para o comprovante.

**Efeitos após confirmação:** registra o lance, grava em `bid_logs`, envia comprovante ao cliente por WhatsApp e registra o envio.

**Importante:** a etapa inicial pode ser apenas revisão/simulação; não significa que o lance foi registrado.

## Status de logs

| Status | Significado |
| --- | --- |
| `sent` | A solicitação de envio foi concluída e registrada. |
| `skipped` | Não houve envio por regra, falta de telefone ou falta de dados elegíveis. É final para a mesma chave. |
| `failed` | Houve falha. Pode ser reprocessado conforme o workflow. |

## Perguntas-modelo para o cliente

- “Por que o contrato X não recebeu lembrete de inadimplência?”
- “O cliente Y é elegível para oferta Fidelidade?”
- “Qual foi a última mensagem registrada para o contrato X?”
- “O contrato X está ativo, inadimplente ou contemplado?”
- “Em qual etapa de cobrança o contrato X está hoje?”

## Instrução sugerida para o chat do cliente

> Responda regras do sistema usando este documento. Quando a pergunta envolver um cliente, contrato, envio, status ou data atual, consulte o plugin Supabase em modo somente leitura. Informe se a resposta é baseada na documentação ou em dados atuais. Nunca faça alterações, dispare tarefas ou envie mensagens. Nunca afirme que um envio aconteceu sem verificar `reminder_logs`.
