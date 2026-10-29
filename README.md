# Servopa Automações

Automações do Grupo Capuzzo no Trigger.dev, com integração ao portal Servopa,
Supabase principal e complementar e WhatsApp via Z-API.

## Documentação operacional

Para preparar o agente técnico de outra pessoa, use
[ONBOARDING-AGENTE.md](ONBOARDING-AGENTE.md) e a skill
[servopa-operations](.agents/skills/servopa-operations/SKILL.md).
Ela reúne setup, mapa dos fluxos/tabelas, diagnóstico e estado de publicação.
Credenciais reais devem ser configuradas separadamente no `.env` local.

[Documentação Fluxos no Notion](https://app.notion.com/p/35d8271577b980808fa2eddfcf21333e)
descreve objetivos, horários, tabelas, efeitos e resultados das tarefas.

A rotina diária começa às 08:00 em `America/Sao_Paulo`: sincronização,
pagamento D2, verificação de ativos, aniversário e contemplação. A cobrança
de inadimplentes acontece a partir das 12:00, seguida do resumo operacional.

Os novos crons de produção estão em `src/trigger/monthly-schedules.ts`, no fuso
`America/Sao_Paulo`, com horário nominal de 09:00:

- `scheduled-offers`: dias 1 e 15 de cada mês, chama `offer-reminder`.
- `scheduled-groups-sync`: dias 1 e 15 às 07:00, chama `groups-sync` para
  atualizar os grupos antes das ofertas das 09:00.
- `scheduled-submit-bid`: dias 6, 14 e 18, chama `submit-bid` para os vencimentos
  8, 16 e 20, respectivamente. Mantém a aprovação gerencial e os logs mensais.

A regra usa vencimento menos dois dias, não assembleia menos dois dias.
Não há planejador mensal nem criação de runs futuras por cliente. O Trigger
registra as recorrências no deploy e cria uma execução em cada ocorrência.
Os novos crons ficam restritos à produção; executar dev não os ativa.
O horário efetivo depende da janela aplicada pelo plano e da fila do Trigger.
Replays de datas antigas são bloqueados; recuperação manual deve usar as tarefas
originais após conferir os logs. Novos dias de vencimento exigem atualizar o cron
e sua seleção. As ofertas do dia 15 não refazem o lote de lances do dia 14.

O `offer-reminder` consulta `grupos.regras_assembleias` em cada execução e
calcula a hierarquia de Fidelidade daquele grupo (por exemplo, 30/15 ou
30/20/10). Cruza essa hierarquia com as opções individuais disponíveis na
Servopa e com o estado de `lances`; histórico de mensagens não comprova aceite.
Contratos sem estado conhecido ficam pendentes de revisão. O dry run retorna
hierarquias, lances atuais, candidatos e motivos de exclusão, sem gravar ou enviar.

Respostas às ofertas, confirmação gerencial por webhook e envio de PDF por
e-mail dependem de processos externos a este repositório.

## Desenvolvimento

A task `groups-sync` consulta os grupos distintos de `bd_producao` e os já
armazenados em `grupos`. Atualiza cadastro, regras por faixa de assembleia,
taxas de administração com suas condições e calendário; registra cada tentativa
em `grupos_sincronizacoes`. Não coleta mais histórico de lances nem grava planos.
Execute com `{ "dryRun": true }` para ler o portal sem gravar, ou
`{ "groups": [1565], "dryRun": true }` para limitar a consulta. Sem `groups`,
consulta toda a referência. Seções com falha preservam seus dados anteriores;
taxas só são substituídas depois de leitura completa. As observações e condições
das regras ficam nos JSONs, sem inferir elegibilidade individual. A task não envia mensagens
e é chamada pelo cron `scheduled-groups-sync` nos dias 1 e 15 às 07:00 São Paulo.
A sincronização e as ofertas têm horários independentes: falha na atualização
preserva dados anteriores e não bloqueia automaticamente a análise de ofertas.

### Migração para grupos estruturados

Concluída no projeto atual em 29/10/2026: SQLs 002/003 aplicados, população
validada e produção `20261029.3`. As etapas abaixo documentam a migração;
não repetir o backfill legado após remover `regras_texto` e `planos`.

Esta mudança exige SQL administrativo; credencial REST não executa DDL.
Não publicar a nova versão antes da etapa 1 e do backfill:

1. Aplicar `sql/002_grupos_estruturados.sql`: adiciona `regras_assembleias`,
   `taxas_administracao` e a view `grupos_regras_assembleias`; não exclui dados.
2. Conferir e migrar o estado existente (cria backup ignorado em `.local` antes de escrever):

```sh
node --env-file=.env --import tsx scripts/migrate-group-structure.ts
node --env-file=.env --import tsx scripts/migrate-group-structure.ts --apply
```

3. Publicar, executar `groups-sync` normal e validar os grupos e as duas colunas.
4. Aplicar `sql/003_grupos_limpeza.sql`, que bloqueia exclusão se faltarem regras
   ou taxas em algum grupo. Remove somente as nove colunas aprovadas de `grupos`.
   Não altera `disponivel_para_vender`, `resultado_ultimas_assembleias` ou dados de clientes.

`regras_assembleias` tem faixas inclusivas (`assembleia_inicio`, `assembleia_fim`,
com fim `null` quando ilimitado), `modalidades` em ordem e `observacoes`.
Modalidades distinguem SORTEIO/FIXO/FIDELIDADE/LIVRE, percentual e uso de embutido.
Dois sorteios permanecem duas entradas. A view apresenta uma linha por modalidade/faixa.
`taxas_administracao` mantém categoria, descrição, percentual, crédito e prazos;
um grupo pode ter várias taxas. `updated_at` é a última gravação, não prova de
atualização completa: conferir sucesso/falha por seção em `grupos_sincronizacoes`.

Requer Node.js com npm. Python é usado na matriz ampla de diagnóstico de login.

```sh
npm ci
npm run check
npm run workflow -- overdue --date 2026-07-28 --fixture test-fixtures/overdue.json
```

Copie `.env.example` para `.env` e configure valores localmente ou no ambiente
do Trigger.dev. A configuração complementar é necessária para a seleção
normal de aniversariantes e a verificação de clientes ativos. O script de
envio de teste carrega `.env`; as tarefas usam o ambiente do executor.

## Estrutura

- `src/trigger/`: tarefas e orquestração.
- `src/lib/`: integrações, regras e templates.
- `scripts/`: verificações; o envio de teste usa dados configurados no `.env`.
- `test-fixtures/`: exemplos fictícios para verificações sem efeitos externos.
- `docs/` e `context.md`: documentação local e histórico de desenvolvimento;
  podem conter regras superadas. Consulte o Notion para o guia operacional atualizado.

Arquivos de ambiente reais, exportações, resultados locais, dependências e
caches estão excluídos pelo `.gitignore`.
