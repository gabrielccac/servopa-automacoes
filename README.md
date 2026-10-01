# Servopa Automações

Automações do Grupo Capuzzo no Trigger.dev, com integração ao portal Servopa,
Supabase principal e complementar e WhatsApp via Z-API.

## Documentação operacional

[Documentação Fluxos no Notion](https://app.notion.com/p/35d8271577b980808fa2eddfcf21333e)
descreve objetivos, horários, tabelas, efeitos e resultados das tarefas.

A rotina diária começa às 08:00 em `America/Sao_Paulo`: sincronização,
pagamento D2, verificação de ativos, aniversário e contemplação. A cobrança
de inadimplentes acontece a partir das 12:00, seguida do resumo operacional.

O calendário de ofertas e lances está definido na documentação e ainda será
implementado no código: oferta um dia antes da primeira execução mensal de
lances; lances dois dias antes da assembleia dos respectivos clientes.

Respostas às ofertas, confirmação gerencial por webhook e envio de PDF por
e-mail dependem de processos externos a este repositório.

## Desenvolvimento

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
