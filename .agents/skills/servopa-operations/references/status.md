# Estado da entrega — 29/10/2026

Esta é uma fotografia, não uma afirmação permanente. Consulte o worker ativo e o
Git antes de trabalhar. O código e os guias são distribuídos pelo repositório
oficial; publicação no GitHub não significa deploy no Trigger.dev.

## Produção confirmada

- Projeto Trigger: `proj_wmgnkaivkyvudwfshcad`.
- Worker confirmado em 29/10: **20261023.1**, SDK **4.5.16**, 12 tarefas.
- Esse deploy incluiu retry HTTP, filtro de cartão de crédito no lembrete D2,
  validação e reextração de link de boleto, contemplações de hoje e ontem.
- Repositório: https://github.com/gabrielccac/servopa-automacoes
- Esta entrega inclui o código de grupos, a nova seleção de ofertas, a skill,
  o setup e os guias versionados. Consulte o histórico de commits da branch.

## Implementado no código, ainda sem deploy confirmado

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
33 testes passaram; o servidor dev utilizado no teste foi encerrado.

## Decisões e pendências

- A gestora ainda vai decidir o tratamento dos contratos sem lance conhecido.
  Por enquanto, manter a exclusão; não alterar para primeira oferta por conta própria.
- Planejador mensal **ainda não implementado**. Proposta: lances dois dias corridos
  antes da assembleia de cada grupo; ofertas um dia antes da primeira execução
  mensal de lances. Não há agendamento automático desses dois fluxos.
- Frequência de `groups-sync` ainda não definida: semanal ou quinzenal foram discutidas.
- O calendário foi encontrado com datas passadas e futuras; próximas assembleias
  conferiram nos 32 grupos e havia datas até junho/2027. Refazer a checagem quando necessário.
- Regras dos grupos estão em texto; interpretação automática identifica percentuais
  de Fidelidade, mas não reconstrói histórico de pagamentos nem aplica fases da assembleia.
  A consulta individual decide a disponibilidade naquele momento.
- `lances_submetidos` ainda protege por contrato e mês, não por assembleia.
- O recebimento de respostas de ofertas e a confirmação por webhook são externos
  a este repositório; confirmar compatibilidade com percentuais 20/10 antes de publicar.

## Documentação externa

- Atual: https://app.notion.com/p/35d8271577b980808fa2eddfcf21333e
- Setup de agentes: https://app.notion.com/p/4088271577b981daadd2e0ae63f2cb36
- Arquivo antigo: https://app.notion.com/p/3598271577b98078a529f08ff3a93cb7
- Acesso público a uma página não garante acesso público às páginas referenciadas.
- `docs/SISTEMA-TECNICO.md`, `context.md` e documentos antigos podem conter nomes
  de arquivos, tabelas, horários e regras superados. Não use isoladamente como verdade atual.
