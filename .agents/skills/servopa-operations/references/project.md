# Mapa do projeto

## Arquitetura e fontes

Servopa é a fonte operacional. Trigger.dev executa TypeScript, Supabase armazena
cadastros/estado/auditoria e Z-API envia WhatsApp. O Supabase complementar fornece
cadastros e contratos para aniversário e verificação de ativos.

- Projeto Trigger: `proj_wmgnkaivkyvudwfshcad`.
- Organização/projeto no dashboard: `flower-agency-8da0` / `servopa-NLPE`.
- Produção: https://cloud.trigger.dev/orgs/flower-agency-8da0/projects/servopa-NLPE/env/prod
- Portal: https://www.consorcioservopa.com.br/vendas/login
- Contrato (`nr_contrato`) não é CPF, telefone ou cota. Grupo e cota contextualizam a navegação.
- `nr_cota` costuma conter plano e dígito separados por hífen; use os parsers existentes.

## Onde alterar cada coisa

| Arquivo/pasta | Responsabilidade |
|---|---|
| `src/trigger/*.ts` | Entradas das tarefas e orquestração |
| `src/lib/config.ts` | Leitura/caching das variáveis de ambiente |
| `src/lib/servopa/http-client.ts` | Login, sessão, HTTP e retries |
| `src/lib/servopa/customer-context.ts` | Ativação de grupo/cota/contrato |
| `src/lib/servopa/customer-payment-info.ts` | Extrato, parcelas emitidas/pagas e recuperação de links |
| `src/lib/servopa/customer-lances.ts` | Opções individuais disponíveis de lance |
| `src/lib/servopa/customer-bid-simulation.ts` | Simulação antes de registrar |
| `src/lib/servopa/customer-bid-register.ts` | Registro e comprovante |
| `src/lib/servopa/groups.ts` | Parsing de busca e detalhes administrativos dos grupos |
| `src/lib/supabase/client.ts` | Clientes REST principal e complementar |
| `src/lib/supabase/daily-sync.ts` | Importação/upsert dos relatórios |
| `src/lib/supabase/customers.ts` | Seleções de clientes e datas |
| `src/lib/supabase/groups.ts` | Coleta, merge e auditoria dos grupos |
| `src/lib/supabase/offer-reminder.ts` | Estados dos lances e regras dos grupos para ofertas |
| `src/lib/reminders/offer-policy.ts` | Hierarquia e decisão de evolução de Fidelidade |
| `src/lib/reminders/shared.ts` | Payloads, idempotência e envio/validação compartilhados |
| `src/lib/whatsapp/templates.ts`, `zapi.ts` | Texto e transporte WhatsApp |
| `scripts/workflow.ts`, `test-fixtures/` | Verificações sem efeitos externos usando fixtures |
| `sql/001_grupos.sql` | Criação das duas tabelas de grupos; já aplicada nesta entrega |

## Tarefas e efeitos

| ID | O que faz | Efeito da execução normal |
|---|---|---|
| `daily-orchestrator` | Agenda diária 08:00 São Paulo; organiza as tarefas e aguarda 12:00 para inadimplência | Sincronizações, mensagens e resumo |
| `daily-sync` | Extrai relatórios da Servopa e importa cadastros/assembleias/disponibilidade/inadimplência | Geração de relatório, escrita no Supabase e possível resumo |
| `payment-reminder` | Busca vencimento D+2, confirma boleto no extrato | Mensagem boleto/Pix e log |
| `verify-active-customers` | Verifica evidências de contratos no Supabase complementar | Atualiza `clientes.status` no complementar, com proteção contra inativação em massa |
| `birthday-reminder` | Aniversariantes, deduplicados preferencialmente por CPF | Mensagem e log |
| `contemplation-reminder` | Contemplação hoje/ontem, referência de log na data do evento | Mensagem e log sem repetição entre esses dias |
| `overdue-payment-reminder` | Ciclos de atraso: D1, D7, D14 e a cada 14 dias depois disso | Mensagem, boleto/Pix e log |
| `fidelidade-sync` | Preenche `gp_fidelidade` ainda nulo com referência de resultados dos grupos | Atualização de cadastro; não é o fluxo de oferta |
| `offer-reminder` | Analisa evolução disponível por contrato e agrupa mensagem por cliente/condição | Envio de oferta com botões e logs; aceite externo |
| `submit-bid` | Pré-checagem, revisão gerencial, simulação, registro e comprovante | Mensagens, espera por confirmação, registro financeiro e auditoria |
| `scheduled-submit-bid` | Cron de produção dias 6, 14 e 18, 09:00 São Paulo; seleciona vencimentos 8, 16 e 20 | Chama `submit-bid` com aprovação gerencial e proteção por data |
| `scheduled-offers` | Cron de produção dias 1 e 15, 09:00 São Paulo | Chama `offer-reminder` com os dados atuais e proteção por data |
| `scheduled-groups-sync` | Cron de produção dias 1 e 15, 07:00 São Paulo | Chama `groups-sync` para atualizar todos os grupos descobertos |
| `groups-sync` | Busca e atualiza características de cada grupo | Escrita nas duas tabelas de grupos; nenhum WhatsApp |
| `diagnose-servopa-access` | Diagnóstico de acesso do portal | Requisições de diagnóstico; ler payload/esquema antes de usar |
| `diagnose-servopa-login-matrix` | Diagnóstico de perfis de login | Tentativas de autenticação; pode usar Python |

Há quatro definições de cron: `daily-orchestrator` e os três wrappers em
`src/trigger/monthly-schedules.ts`. Os novos crons são exclusivos de produção;
as tarefas originais continuam disponíveis para execução manual e dry run.
As datas de lances usam vencimento menos dois dias, sem planejador mensal.
O horário nominal é sujeito à janela do plano e à fila. Não criar crons duplicados
nos filhos. Replays dos wrappers fora da data pretendida são bloqueados.
O cron de grupos às 07:00 antecede as ofertas das 09:00, mas não cria dependência
de sucesso entre eles. Falhas por seção preservam os dados anteriores; conferir
os resultados por seção em `grupos_sincronizacoes` ao investigar uma oferta.

## Tabelas principais

| Tabela | Papel e campos importantes |
|---|---|
| `bd_producao` | Cadastro por contrato; `nr_contrato`, `nr_grupo`, `nr_cota`, `nm_consorciado`, `cd_whatsapp`, `dt_cancelamento`, `nr_diavenc`, `dt_contemplacao`, `gp_fidelidade`, `tp_lance`, `ds_meio_pagamento` |
| `bd_clientes` | Dados complementares, inclusive aniversário; conferir os campos reais |
| `lances` | Configuração atual do lance automático: `nr_contrato`, `tp_lance`, `pct_lance`, `diluicao_em_parcelas` |
| `lances_submetidos` | Auditoria real de submissão: contrato, `reference_month`, status `submitted`/`failed`, protocolo, comprovante e erro |
| `reminder_logs` | Envios/decisões: contrato, tipo, referência, chave de idempotência, status, mensagem, ID externo, erro e datas |
| `inadimplentes` | Ciclos: `dt_primeira_ocorrencia`, `dt_ultima_ocorrencia`, `st_ativo` e contexto da cota |
| `resultado_ultimas_assembleias` | Relatório por grupo/modalidade; não é a agenda completa futura |
| `disponivel_para_vender` | Disponibilidade comercial do relatório; não substitui os detalhes dos grupos |
| `grupos` | Características, regras por faixa, taxas com condições e calendário em JSONB |
| `grupos_regras_assembleias` | View: uma linha por grupo/faixa/modalidade; não duplica armazenamento |
| `grupos_sincronizacoes` | Auditoria de cada tentativa de atualização de grupo |

Não procurar `logs_lances` ou assumir que a tabela se chama `bid_logs`:
`src/lib/supabase/bid-logs.ts` trabalha com **`lances_submetidos`**.
`reference_month` é uma data como `2026-10-01`, não a string `2026-10`.

No complementar, `clientes` é consultada junto de `assinados_investimento`,
`consultoria`, `mentoria`, `contratos_servicos` e `contratos_Titulo-Privado` pela
verificação de ativos. Não confundir esse status com `bd_producao.dt_cancelamento`.

## Regras de dados e idempotência

- A sincronização preserva WhatsApp curado em `cd_whatsapp`, preenchendo-o da
  origem apenas quando está vazio. Nome pode voltar a ser alterado pela origem
  na próxima sincronização; uma correção local precisa considerar isso.
- Em `reminder_logs`, `sent` e `skipped` são terminais para a mesma chave;
  `failed` permite reprocessamento. Não apagar logs para forçar reenvio.
- Pagamento D2 usa como referência o vencimento futuro, não a data do disparo.
- Contemplação usa a data do evento, para não repetir no dia seguinte.
- Ofertas usam chave por contrato e tipo/percentual, sem reiniciar a cada mês.
- Lances submetidos usam contrato e mês. Não é proteção por assembleia ainda.
- Inadimplência mantém ciclos: não reiniciar `dt_primeira_ocorrencia` em cada sync;
  contratos que saem do relatório encerram o ciclo e retornos abrem outro.
- Aniversário usa CPF normalizado quando disponível e contrato como fallback.

## Pagamentos e boletos

O lembrete D2 exclui somente `CARTAO DE CREDITO` com normalização de espaços e
acentos. PIX, boleto, link e as demais formas continuam elegíveis pela regra aprovada.
Payload manual também passa pelo filtro da forma de pagamento cadastrada.

A confirmação usa o extrato Servopa e valida o contrato. O boleto principal de
vencimento é a maior parcela; na inadimplência, boleto único, ou diluição em caso
de múltiplos, ou a maior parcela na falta de diluição.

Antes de enviar um botão Boleto, uma consulta pública sem cookies precisa retornar
conteúdo iniciado por `%PDF-`. Um antigo problema retornava `200` com corpo `Erro`.
Se falhar, há uma nova extração no extrato para a mesma parcela/tipo e contrato,
com atualização conjunta dos links de boleto/Pix, seguida de nova validação.
Se continuar inválido, não envia. Não há armazenamento/envio de PDF nessa validação.
O link pode expirar depois do envio; a duração da validade não foi comprovada.

## Ofertas e lances

`fidelidade-sync` indica evidência histórica de modalidade do grupo; não prova que
um cliente está apto hoje. A nova oferta lê `grupos.regras_assembleias`, valida as
faixas e extrai somente percentuais de modalidades FIDELIDADE, deduplica e ordena a hierarquia. Falha de
interpretação bloqueia aquele grupo. Exemplo: `[30, 20, 10]`.

Somente estado conhecido de `lances` segue para evolução. Fixo é uma modalidade
diferente de Fidelidade. A seleção procura a melhor evolução da hierarquia que
também apareça como disponível na página do contrato. Não reconstrói pagamentos
ou inadimplência e não aplica fases de assembleia separadamente. Regras do grupo
podem descrever quando uma modalidade surge; o portal individual confirma a opção atual.

Motivos de exclusão incluem `unknown_current_lance`, `group_rules_unavailable`,
`group_has_no_fidelidade`, `already_at_last_tier`, `current_lance_not_in_group_hierarchy`,
`unsupported_current_lance_type`, `already_sent_offer`, `next_offer_not_available`.
Ausência de candidato não significa erro; confira o motivo.

`submit-bid` consulta somente lances configurados, considera `dtVenc` quando
informado e respeita o que já está submetido no mês. Após checagem, a execução
normal envia revisão ao gerenciador e espera token de confirmação. Depois simula,
registra e envia comprovante. Não contornar essa confirmação.
`stopBeforeRegister: true` não equivale a dry run: ainda pode enviar mensagens,
criar token e simular depois da confirmação. Para teste sem efeitos de envio/registro,
use `dryRun: true`.

## Grupos e JSONB

Os campos fixos mantidos incluem grupo, segmento, prazo total, vagas, número de
consorciados, vencimento, percentuais de embutido/reserva/seguro, tipo de sorteio,
seguro/grupo, próxima assembleia, disponibilidade e `updated_at`.
As bases originais do Daily Sync permanecem intactas. A limpeza remove somente
`previsao_reajuste`, `planos`, `historico_lances`, `regras_texto`, `contemplados_sorteio`,
`contemplados_lance`, `ultima_visualizacao_em`, `atualizacao_secoes` e `created_at`
de `grupos`, após migrar e validar os JSONs novos.

| JSONB | Conteúdo |
|---|---|
| `taxas_administracao` | Categoria, descrição, percentual de administração, prazo restante/original e valor do crédito; não assumir taxa única por grupo |
| `assembleias` | Número, data, horário, local, cidade e situação |
| `regras_assembleias` | Faixas inclusivas, modalidades ordenadas (inclusive sorteios repetidos) e observações/condições preservadas |

`NULL` significa não coletado/disponível; `[]` significa lista coletada sem itens,
não falha. Zero informado é um valor real. Percentuais usam pontos: `30` representa
30%, não 0,30. Valores monetários e percentuais dos JSONs são números, não texto pt-BR.
Datas em JSON usam ISO; horários do calendário são locais de São Paulo. A coluna
`proxima_assembleia_em` é `timestamptz`, portanto a API pode retorná-la em UTC.

Os merges preservam assembleias anteriores. Taxas são substituídas somente com
leitura completa. Falha de seção preserva seu conteúdo, registrada na auditoria;
`updated_at` sozinho não comprova que todas as seções foram atualizadas.
Busca sem identificação inequívoca do grupo não apaga o registro antigo.
`assembleia_fim: null` indica faixa sem limite; percentuais nulos não significam zero.
LIVRE COM EMBUTIDO 30% usa `percentual_embutido: 30`, não percentual de lance fixo.
Regras não reconhecidas falham e preservam o JSON anterior; não inventar faixas.

Em `grupos_sincronizacoes`, cada tentativa registra `nr_grupo`, `trigger_run_id`,
`status` (`sucesso`, `parcial`, `falha`), datas, `resultado_secoes` e `erro`.
Não há FK obrigatória para permitir log de falha na primeira coleta. Uma carga
local pode ter `trigger_run_id = NULL`. Gravação de grupo e log são requisições
REST distintas: falha na auditoria interrompe o workflow e exige conferir o banco.

## HTTP e integração

O cliente usa `wreq-js`. Login possui fallback entre perfis de navegador.
Requisições têm até três tentativas, com pausas de 2s e 5s. HTTP 403 é repetido;
erros transitórios de rede e outros status são repetidos em operações marcadas
seguras. POST de registro não deve ser repetido cegamente após resposta perdida,
pois o fornecedor pode ter executado a ação. Preservar a sessão/contrato nos retries.

Buscas administrativas: POST `/vendas/grupos` com `URLSearchParams` (`grupofrm`,
`tp_lance`); detalhes GET `/vendas/grupos/<grupo>/S`. A consulta adicional `/L`
foi retirada junto com o histórico de lances. Botões de venda não fazem parte da coleta.

O projeto usa Z-API para envio e serviços externos para respostas/aceites e
redirecionamento da confirmação gerencial. Não afirmar que o processamento dos
botões ou uma integração de e-mail está implementada aqui sem localizar o código.
