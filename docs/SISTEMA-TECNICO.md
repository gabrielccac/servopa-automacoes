# Documentação técnica do sistema

## Visão geral

O projeto automatiza rotinas de consórcio usando quatro componentes:

```text
Servopa ──> Trigger.dev ──> Supabase
                 │              │
                 └──> Z-API <───┘
```

- **Trigger.dev:** executa tarefas agendadas e manuais em `src/trigger/`.
- **Servopa:** fonte operacional; fornece relatórios, valida dados de pagamento, opções de lance e registra lances.
- **Supabase:** base operacional e histórico dos workflows.
- **Z-API:** canal de WhatsApp, para clientes e resumos operacionais.

## Estrutura do código

| Caminho | Responsabilidade |
| --- | --- |
| `src/trigger/` | Tarefas Trigger.dev e pontos de entrada dos workflows. |
| `src/lib/supabase/` | Consultas REST e sincronização com o Supabase. |
| `src/lib/whatsapp/` | Templates, integração Z-API e resumos de execução. |
| `src/lib/reminders/` | Payloads, dry run, envio e idempotência compartilhados. |
| `src/lib/customer-payment-info.ts` | Consulta e interpretação do extrato/boleto no Servopa. |
| `src/lib/customer-lances.ts` | Consulta de opções de lance no Servopa. |
| `src/lib/http-client.ts` | Sessão autenticada do Servopa. |
| `trigger.config.ts` | Projeto Trigger.dev, diretórios, retries e duração padrão. |

## Integrações e limites técnicos

### Servopa

- As tarefas que consultam Servopa abrem uma sessão, processam clientes em sequência e fecham a sessão ao final.
- A sessão possui contexto de cliente; por isso não se deve paralelizar a mesma sessão entre clientes.
- A integração usa perfil de navegador e HTTP/2 para passar pela proteção do fornecedor.

### Supabase

- O acesso da aplicação usa REST com chave de serviço configurada em ambiente.
- O identificador do projeto é `umvldqzzliqmgkvoedyd`.
- O chat do cliente deve usar um plugin **somente leitura**, com acesso limitado às tabelas necessárias.
- A base é a fonte de estado para elegibilidade, ciclos de inadimplência e histórico de comunicação.

### Z-API

- Há dois tipos de envio: texto simples e texto com botões URL.
- O retorno da Z-API é armazenado como `external_message_id` quando o envio é registrado em `reminder_logs`.
- Aceitação da API não substitui uma confirmação externa de entrega.

## Configuração

As variáveis são lidas por `src/lib/config.ts`. Nunca documentar valores reais nem expor arquivos `.env`.

| Grupo | Variáveis |
| --- | --- |
| Servopa | `SERVOPA_CPF_CNPJ`, `SERVOPA_SENHA` |
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| Supabase complementar | `ALT_SUPABASE_URL`, `ALT_SUPABASE_SERVICE_ROLE_KEY` |
| Z-API | `ZAPI_BASE_URL`, `ZAPI_INSTANCE_ID`, `ZAPI_INSTANCE_TOKEN`, `ZAPI_CLIENT_TOKEN` |

## Modelo de dados operacional

### `bd_producao`

Cadastro principal por contrato. Campos usados com frequência: `nr_contrato`, `nr_cota`, `nr_grupo`, `nm_consorciado`, `cd_whatsapp`, `dt_cancelamento`, `nr_diavenc`, `dt_contemplacao`, `gp_fidelidade`, `tp_lance` e `pct_lance`.

É atualizado diariamente por upsert usando `nr_contrato` como conflito. O telefone curado `cd_whatsapp` não é sobrescrito pelo telefone bruto de origem.

### `inadimplentes`

Mantém ciclos históricos de inadimplência. Campos críticos: `nr_contrato`, `nr_cota`, `cd_whatsapp`, `dt_primeira_ocorrencia`, `dt_ultima_ocorrencia` e `st_ativo`.

Durante a sincronização:

- contrato novo no relatório: cria ciclo com `st_ativo = true` e as duas datas iguais ao dia da sync;
- contrato já ativo no relatório: mantém `dt_primeira_ocorrencia` e atualiza `dt_ultima_ocorrencia`;
- contrato que saiu do relatório: fecha o ciclo com `st_ativo = false`;
- retorno posterior do contrato: abre um novo ciclo.

### `reminder_logs`

É a auditoria de lembretes e a barreira contra duplicação. Principais campos: `idempotency_key`, `nr_contrato`, `reminder_type`, `reference_date`, `status`, `message_body`, `external_message_id`, `last_error` e `sent_at`.

- `sent` e `skipped` são terminais para a mesma chave.
- `failed` pode ser reprocessado.
- Uma mesma cota pode possuir vários logs, inclusive de tipos e ciclos diferentes.

### Outras tabelas

| Tabela | Finalidade |
| --- | --- |
| `bd_clientes` | Datas de nascimento e dados complementares. |
| `clientes` | Fonte complementar de aniversariantes, se configurada. |
| `lances` | Lance atual por contrato. |
| `bid_logs` | Auditoria de submissões de lance. |
| `resultado_ultimas_assembleias` | Resultado e modalidades de lance por grupo. |
| `disponivel_para_vender` | Foto corrente de disponibilidade comercial. |

## Workflows

### `daily-sync`

- **Tipo:** agendado diariamente às 11:00 UTC / 08:00 São Paulo.
- **Lê:** relatórios e arquivos do Servopa.
- **Escreve:** `bd_producao`, `bd_clientes`, `inadimplentes`, `resultado_ultimas_assembleias` e `disponivel_para_vender`.
- **Função:** atualiza a base que alimenta os demais workflows.

### `overdue-payment-reminder`

- **Tipo:** agendado diariamente às 12:00 UTC / 09:00 São Paulo, após o `daily-sync`.
- **Lê:** `inadimplentes` com `st_ativo = true`, `reminder_logs` e dados de pagamento no Servopa.
- **Regra:** envia nos dias 1, 7 e 15 desde `dt_primeira_ocorrencia`; após o dia 15, repete a cada 14 dias (29, 43, 57…).
- **Escreve:** `reminder_logs`.
- **Efeito externo:** WhatsApp com boleto/Pix quando disponíveis.
- **Seleção de boleto:** único boleto; em múltiplos, prioriza diluição; sem diluição, prioriza maior `nr_parcela`.

### `payment-reminder`

- **Tipo:** agendado diariamente às 11:00 UTC / 08:00 São Paulo.
- **Lê:** clientes ativos em `bd_producao` cujo `nr_diavenc` corresponde a depois de amanhã; confirma o pagamento no Servopa.
- **Escreve:** `reminder_logs` (`payment_due_d2`).
- **Efeito externo:** WhatsApp de aviso de vencimento com boleto/Pix quando disponível.

### `birthday-reminder`

- **Tipo:** agendado diariamente às 11:00 UTC / 08:00 São Paulo.
- **Lê:** `bd_producao`, `bd_clientes` e opcionalmente `clientes`.
- **Escreve:** `reminder_logs` (`birthday`).
- **Efeito externo:** WhatsApp de aniversário.

### `contemplation-reminder`

- **Tipo:** agendado diariamente às 11:00 UTC / 08:00 São Paulo.
- **Lê:** `bd_producao` ativo com `dt_contemplacao` igual ao dia atual.
- **Escreve:** `reminder_logs` (`contemplation`).
- **Efeito externo:** WhatsApp de contemplação.

### `fidelidade-sync`

- **Tipo:** manual ou disparado por outro processo.
- **Lê:** `bd_producao` e `resultado_ultimas_assembleias`.
- **Escreve:** `bd_producao.gp_fidelidade` quando ainda está nulo.
- **Regra:** um grupo é Fidelidade quando há resultado de assembleia com `tp_lance = FIDELIDADE`.

### `offer-reminder`

- **Tipo:** manual; sem cron configurado.
- **Lê:** `bd_producao` ativo com `gp_fidelidade = true`, `lances`, `reminder_logs` e opções de lance no Servopa.
- **Estado atual do código:** somente análise. Não envia mensagens, não altera lances e não grava logs.
- **Comportamento planejado:** enviar WhatsApp aos candidatos sem lance automático já registrado em `lances`, apresentando a nova oferta Fidelidade e perguntando se o cliente autoriza o lance automático. A confirmação e o registro permanecem em uma etapa separada.
- **Template pendente:** não há template de oferta no código atual; ele será adicionado com o envio.
- **Retorno:** candidatos para Fidelidade 15% ou 30%, clientes ignorados e erros de consulta.

### `submit-bid`

- **Tipo:** manual, com confirmação gerencial no fluxo.
- **Lê:** candidatos, opções de lance e dados de contexto no Servopa; `bid_logs` e `reminder_logs`.
- **Escreve após confirmação:** lance no Servopa, `bid_logs` e `reminder_logs` do comprovante.
- **Efeito externo:** mensagem de revisão ao gestor e comprovante por WhatsApp ao cliente após o registro.

### Tarefas de suporte

| Tarefa | Finalidade |
| --- | --- |
| `verify-active-customers` | Verificação/manutenção de clientes ativos. |
| `overdue-payment-bootstrap` | Tarefa manual de envio inicial; não é o agendamento principal de inadimplência. |
| `test-matrix-login` | Diagnóstico de login Servopa. |
| `webhook-confirmation-test` | Teste de confirmação por webhook. |

## Padrão de payload e execução segura

Os lembretes aceitam, em geral, quatro formas:

```ts
undefined                         // busca clientes na base
customer                          // um cliente
[customer]                       // lista de clientes
{ customers, dryRun, respectIdempotency }
```

- `dryRun: true`: executa seleção e validações, mas não envia WhatsApp nem persiste logs.
- Execuções com payload podem ignorar o filtro de logs para testes direcionados.
- `respectIdempotency: true` restaura a proteção de logs em uma execução por payload.

## Operação e diagnóstico

1. Verifique se `daily-sync` concluiu antes de analisar dados do dia.
2. Para mensagens, consulte `reminder_logs` por contrato, tipo e data de referência.
3. Para inadimplência, confirme primeiro `st_ativo` e `dt_primeira_ocorrencia`.
4. Para oferta Fidelidade, confirme `gp_fidelidade`, lance atual em `lances` e opções disponíveis.
5. Para um problema de envio, diferencie `skipped` (regra/sem dado) de `failed` (erro técnico).

Para perguntas sobre casos específicos, o LLM deve consultar automaticamente o plugin Supabase quando a execução estiver disponível; não deve solicitar confirmação e não deve instruir o cliente a executar SQL. Se o plugin não estiver conectado ou não permitir execução, deve informar que não consegue validar o caso ao vivo. Só deve pedir o número do contrato quando a busca por nome tiver mais de um resultado; nunca deve solicitar chaves ou credenciais.

## Testes locais

```powershell
npm run typecheck
npm test
```

## Documentos para indexação no chat

Indexe estes dois arquivos:

1. `docs/SISTEMA-TECNICO.md` — arquitetura, código, dados e execução.
2. `docs/GUIA-LLM-WORKFLOWS.md` — comportamento explicado para atendimento e instruções de consulta ao plugin.

Não indexe `context.md` junto com estes documentos: ele contém histórico de desenvolvimento e pode ter regras superadas.
