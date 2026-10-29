# Estado da entrega — 29/10/2026

Esta é uma fotografia, não uma afirmação permanente. Consulte o worker ativo e o
Git antes de trabalhar. O código e os guias são distribuídos pelo repositório
oficial; publicação no GitHub não significa deploy no Trigger.dev.

## Produção confirmada

- Projeto Trigger: `proj_wmgnkaivkyvudwfshcad`.
- Worker confirmado em 29/10: **20261029.3**, SDK **4.5.16**, 16 tarefas.
- Deploy: https://cloud.trigger.dev/projects/v3/proj_wmgnkaivkyvudwfshcad/deployments/ugvhpdvc
- Inclui grupos, ofertas por hierarquia e os três novos crons de produção, além dos
  retries HTTP, filtro de cartão, validação de boleto e contemplação hoje/ontem.
- API confirmou quatro schedules ativos em produção: grupos dias 1 e 15 às 07:00,
  rotina diária às 08:00,
  ofertas dias 1 e 15 às 09:00 e lances dias 6, 14 e 18 às 09:00 São Paulo.
  Novos schedules com `window: "0m"`; próximas datas nominais 01/11 (ofertas)
  e 06/11 (lances); grupos em 01/11. Horários efetivos retornados: 07:00:44
  (grupos), 09:00:26 (ofertas) e 09:00:03 (lances).
  A fila ainda pode atrasar o início. Não há cron novo em dev.
- Repositório: https://github.com/gabrielccac/servopa-automacoes
- Esta entrega inclui o código de grupos, a nova seleção de ofertas, a skill,
  o setup e os guias versionados. Consulte o histórico de commits da branch.

## Revisão estruturada — publicada e populada; limpeza SQL pendente

O código atual troca `regras_texto` por `regras_assembleias` JSONB e `planos` por
`taxas_administracao` JSONB. Mantém tipos, percentuais, próxima assembleia,
calendário, disponibilidade e `updated_at`. Remove os nove campos aprovados
somente após migração validada. As tabelas do Daily Sync não são alteradas.
As faixas preservam a ordem dos sorteios e das modalidades, inclusive repetições,
percentuais, uso de embutido e observações/condições contratuais.
O fluxo de ofertas passa a ler o JSON validado, mantendo a regra de disponibilidade
individual; não aplica bloqueio adicional por fase nem reconstrói pagamentos.

38 testes e TypeScript estrito passaram. SQL 002 aplicado pelo responsável e
confirmado por REST. Backfill aplicado com backup local ignorado em `.local`:
32 grupos, 93 faixas e 881 condições de taxa; hierarquias comparadas com a versão
anterior nos 32 grupos sem divergências. View confirmada com 365 linhas.

Produção: `groups-sync` run `run_06goi73i69td3a44gva7s6v8a2`, concluída em
29/10 às 16:23 São Paulo, `dryRun: false`, worker `20261029.3`. Foram 32 grupos
bem-sucedidos, zero parciais/falhas, 93 faixas, 881 condições de taxa e 757
assembleias. Leitura posterior confirmou os JSONs e os 32 logs da mesma run;
todos atendem aos pré-requisitos do SQL 003. Nenhum WhatsApp ou lance foi disparado.

Pendente somente a execução administrativa de `sql/003_grupos_limpeza.sql` e a
conferência posterior do esquema. Ela já foi liberada após validar a coleta.
As nove colunas antigas ainda estão no banco até essa execução. O acesso REST
não permite DDL; a aplicação da limpeza foi solicitada ao responsável.
Não anunciar a exclusão como concluída antes de verificar o esquema real.

## Histórico anterior à estrutura JSONB

### Grupos

`groups-sync` consulta os números distintos de `bd_producao` e os já cadastrados
em `grupos`; lê cadastro, planos, assembleias e históricos com/sem embutido.
As tabelas `grupos` e `grupos_sincronizacoes` foram criadas manualmente no SQL Editor.
A carga inicial usou a mesma rotina localmente: 32 grupos, 32 logs bem-sucedidos,
881 opções comerciais, 757 assembleias e 220 registros de lances históricos.
Dez grupos não retornaram histórico de lance; isso não significa zero contemplações.
Essas contagens mudam: não as transforme em configuração fixa.

### Ofertas por hierarquia do grupo

`offer-reminder` agora interpreta `grupos.regras_texto` em cada execução. Não há
coluna persistida `hierarquia_fidelidade`: a configuração é derivada em memória e
aparece em `groupConfigs` no resultado. Suporta hierarquias como 30/15 e 30/20/10.
Somente estados conhecidos de `lances` podem gerar uma evolução; mensagens antigas
não substituem esse estado. A disponibilidade individual é consultada na Servopa.

Teste no worker dev **20261029.1**, run
`run_06goh90e1u4u60gheul71cc7a2`: `dryRun: true`, concluído sem erros, 130 contratos,
22 consultas individuais, 7 candidatos agrupados em 4 mensagens previstas.
Zero mensagens enviadas e zero logs de oferta escritos. Motivos de exclusão:
75 estados desconhecidos, 15 sem Fidelidade no grupo, 18 no último nível,
1 oferta já enviada e 14 sem evolução disponível. É evidência histórica, não lista atual.
Na publicação dos crons, 37 testes e TypeScript estrito passaram; os testes dos
wrappers simularam os disparos sem mensagens ou registros financeiros reais.
O servidor dev utilizado no teste integrado anterior foi encerrado.

## Decisões e pendências

- A gestora ainda vai decidir o tratamento dos contratos sem lance conhecido.
  Por enquanto, manter a exclusão; não alterar para primeira oferta por conta própria.
- Planejador mensal **descartado nesta versão**. A regra vigente é vencimento
  menos dois dias: 08→06, 16→14 e 20→18; ofertas fixas dias 1 e 15.
  A seleção de vencimento vem de `bd_producao.nr_diavenc` para os contratos em
  `lances`. Novos dias exigem atualizar o cron e o mapeamento, com teste.
  Os wrappers recusam datas antigas ou fora do calendário e usam chave global
  por data; as tarefas originais continuam disponíveis para recuperação manual.
  A oferta do dia 15 não refaz os lances já processados no dia 14.
- `scheduled-groups-sync` atualiza todos os grupos nos dias 1 e 15 às 07:00
  São Paulo. A tarefa original `groups-sync` continua disponível manualmente.
  O horário antecede as ofertas das 09:00, sem criar dependência automática
  de sucesso; falhas preservam dados anteriores. Conferir logs e timestamps.
- O calendário foi encontrado com datas passadas e futuras; próximas assembleias
  conferiram nos 32 grupos e havia datas até junho/2027. Refazer a checagem quando necessário.
- Regras estão estruturadas por faixa em JSONB; condições contratuais são
  preservadas em `observacoes`. A oferta deriva a hierarquia do JSON, mas não
  reconstrói pagamentos nem aplica bloqueio adicional por fase; a consulta
  individual decide a disponibilidade naquele momento.
- `lances_submetidos` ainda protege por contrato e mês, não por assembleia.
- O recebimento de respostas de ofertas e a confirmação por webhook são externos
  a este repositório; compatibilidade dos callbacks com percentuais 20/10 não foi
  verificada nesta entrega. O dry run anterior não selecionou esses percentuais.

## Documentação externa

- Atual: https://app.notion.com/p/35d8271577b980808fa2eddfcf21333e
- Setup de agentes: https://app.notion.com/p/4088271577b981daadd2e0ae63f2cb36
- Arquivo antigo: https://app.notion.com/p/3598271577b98078a529f08ff3a93cb7
- Acesso público a uma página não garante acesso público às páginas referenciadas.
- `docs/SISTEMA-TECNICO.md`, `context.md` e documentos antigos podem conter nomes
  de arquivos, tabelas, horários e regras superados. Não use isoladamente como verdade atual.
