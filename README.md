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

O `offer-reminder` consulta as regras salvas em `grupos` em cada execução e
calcula a hierarquia de Fidelidade daquele grupo (por exemplo, 30/15 ou
30/20/10). Cruza essa hierarquia com as opções individuais disponíveis na
Servopa e com o estado de `lances`; histórico de mensagens não comprova aceite.
Contratos sem estado conhecido ficam pendentes de revisão. O dry run retorna
hierarquias, lances atuais, candidatos e motivos de exclusão, sem gravar ou enviar.

Respostas às ofertas, confirmação gerencial por webhook e envio de PDF por
e-mail dependem de processos externos a este repositório.

## Desenvolvimento

A task `groups-sync` consulta os grupos distintos de `bd_producao` e os já
armazenados em `grupos`. Atualiza cadastro, planos, assembleias e históricos
com/sem embutido; registra cada tentativa em `grupos_sincronizacoes`.
Execute com `{ "dryRun": true }` para ler o portal sem gravar, ou
`{ "groups": [1565], "dryRun": true }` para limitar a consulta. Sem `groups`,
consulta toda a referência. A execução normal grava os dados e o histórico.
Seções com falha preservam seus dados anteriores; planos ausentes só ficam
indisponíveis após leitura completa. O texto das regras é preservado, sem
inferir a elegibilidade individual dos clientes. A task não envia mensagens
e ainda não tem agendamento automático.

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
