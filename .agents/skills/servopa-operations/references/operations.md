# Diagnóstico, testes e publicação

## Ferramentas necessárias

| Capacidade | Ferramenta preferida | Alternativa |
|---|---|---|
| Editar e testar código | Arquivos/terminal no checkout | Git e editor local |
| Identificar versão e execução | MCP Trigger: `get_current_worker`, `list_runs`, `get_run_details` | Dashboard do projeto |
| Consultar documentação Trigger | MCP `search_docs`; referência instalada do SDK | Documentação oficial |
| Ler dados operacionais | REST via `src/lib/supabase/client.ts` | MCP Supabase autenticado, se disponível |
| Aplicar SQL | Conexão SQL/gestão autorizada | SQL Editor executado pelo responsável |
| Publicar | CLI compatível com SDK | MCP de deploy, conferindo projeto/ambiente |
| Sincronizar Git | Git/credencial da gestora | GitHub CLI autenticado |

Os nomes MCP variam com o cliente e a versão. Descubra as ferramentas e leia seus
esquemas; não copie prefixos desta conversa. Evite consultar recursos genéricos de
MCP como substituto de ferramentas de um app quando o cliente exige descoberta própria.

## Investigar uma execução

1. Fixe tarefa, ambiente e data civil em São Paulo. Para o dia 22/10/2026, por
   exemplo: `from=2026-10-22T03:00:00Z`, `to=2026-10-23T03:00:00Z`.
2. Liste runs da tarefa, seguindo a paginação. Consulte detalhes de cada run relevante.
3. Confira payload, versão, origem manual/agendada, tentativas e estado final.
4. Leia output, contadores, motivos e erros individuais. `COMPLETED` pode conter
   clientes com `failed`; zero selecionados é diferente de uma falha de execução.
5. Correlacione contrato e referência com o Supabase. Use ID externo de mensagem
   como evidência de aceitação da API, não como confirmação de entrega.
6. Responda com tabela curta: contrato, grupo/cota quando relevantes, estado,
   motivo, horário brasileiro e link da run. Não despeje todos os dados pessoais.

Payloads típicos do MCP, adaptando ao esquema descoberto:

```json
{
  "projectRef": "proj_wmgnkaivkyvudwfshcad",
  "environment": "prod",
  "taskIdentifier": "offer-reminder",
  "from": "2026-10-29T03:00:00Z",
  "to": "2026-10-30T03:00:00Z",
  "limit": 30
}
```

Uma lista de runs sem resultado exige verificar janela, tarefa, ambiente e
paginação antes de concluir que não executou. O worker atual não prova qual
versão foi usada por uma execução anterior: leia a versão da própria run.

## Consultar Supabase sem expor credenciais

Use a implementação existente; ela pagina o REST. Se for usar `fetch` diretamente,
construa a URL com `URL`/`searchParams`, carregue segredos apenas no processo e
não imprima cabeçalhos, `.env` ou retornos irrestritos.

Exemplo de leitura na raiz, após instalar dependências e configurar `.env`:

```js
// Executar como módulo TypeScript com tsx e --env-file=.env.
import { supabaseRestGetAll } from "./src/lib/supabase/client.js";
const rows = await supabaseRestGetAll(
  "/rest/v1/reminder_logs?select=nr_contrato,status,reference_date,last_error,sent_at" +
  "&reminder_type=eq.contemplation&reference_date=eq.2026-10-22"
);
console.log(JSON.stringify(rows));
```

No terminal, prefira arquivo temporário em `.local/` a concatenar SQL/JavaScript
com conteúdo de usuário. Filtre pelo contrato, tipo e referência. Ao buscar nomes,
confirme o contrato antes de tratar homônimos como o mesmo cliente. Não selecione
CPF ou todos os telefones se a pergunta só exige estado/contagens.

Relacionamentos usuais:
- Mensagem: `reminder_logs.nr_contrato` → `bd_producao.nr_contrato`.
- Lance atual: `lances.nr_contrato` → cadastro.
- Submissão: `lances_submetidos.nr_contrato` + `reference_month`.
- Regras/agenda: `bd_producao.nr_grupo` → `grupos.nr_grupo`.
- Última coleta: `grupos_sincronizacoes.nr_grupo`, ordenando `iniciado_em` desc.

## Perguntas frequentes e caminhos de investigação

| Pergunta | Conferir |
|---|---|
| “Recebeu a mensagem?” | Run, `reminder_logs`, ID da Z-API e eventual evidência de entrega; não inferir entrega por `sent` |
| “Por que skipped?” | Motivo no output e chave terminal existente, não apenas o cadastro atual |
| “Recebeu só um dos contratos?” | Todos os contratos/cotas e agrupamento por telefone; comparar plano de envio e logs por contrato |
| “Nome/telefone errado?” | Payload da run e cadastro no momento do envio; fonte de sincronização e preservação do WhatsApp |
| “Contemplado ontem não recebeu?” | Horário da sync, data de contemplação, janela hoje/ontem e log pela data do evento |
| “Não recebeu oferta?” | Hierarquia do grupo, estado conhecido em `lances`, disponibilidade individual, oferta anterior e motivo de exclusão |
| “403?” | Tentativas HTTP, perfil de login, contexto e operação; não resolver removendo validação de contrato |
| “Link do boleto dá erro?” | Acesso público e assinatura PDF, HTTP 200 com texto de erro, reextração da mesma parcela; não concluir validade por status apenas |
| “Quando é o lance?” | Calendário real do grupo, mês e estágio de implementação do planejador; vencimento não é assembleia |

## Payloads para testes sem envio

| Tarefa | Payload sugerido | O que efetivamente testa |
|---|---|---|
| `offer-reminder` | `{ "dryRun": true }` | Base, regras dos grupos, estados e disponibilidade individual; monta `sendPlan` |
| `submit-bid` | `{ "dtVenc": 16, "dryRun": true }` | Pré-checagem dos lances; não chega à simulação pós-confirmação/registro |
| `groups-sync` | `{ "groups": [1565], "dryRun": true }` | Consulta administrativa e merge previsto, sem gravações |
| `payment-reminder` | `{ "dryRun": true, "sendSummary": false }` | Seleção/extrato; a validação pública pré-envio do boleto não roda no dry run |
| `contemplation-reminder` | `{ "dryRun": true, "asOfDate": "2026-10-22" }` | Seleção hoje/ontem relativamente à referência e idempotência |
| `daily-sync` | `{ "dryRun": true }` | Retorno sem escrita; não comprova extração real dos relatórios |
| `verify-active-customers` | `{ "dryRun": true }` | Leitura e cálculo sem alterar status |

Payloads de cliente manuais variam por tarefa. Não inventar um cliente mínimo para
contornar seleção: leia as chaves exigidas no código/esquema. `asOfDate` não deve
ser retrocedida em uma submissão real para burlar o controle mensal.

## Desenvolvimento e deploy

**Migração de grupos estruturados:** antes de publicar a mudança que remove
`regras_texto`, seguir as quatro etapas do README (SQL 002 → backfill com backup →
deploy + groups-sync → SQL 003). Não executar a limpeza antes da população validada.
Use a view `grupos_regras_assembleias` para consultar faixas/modalidades; confira
`assembleia_inicio`/`assembleia_fim`, ordem e percentuais. Condições contratuais
ficam em `observacoes`, sem inferir elegibilidade individual.

1. Inspecione `git status`, branch e versão ativa. As alterações devem partir do
   código correto, incluindo mudanças locais ainda não publicadas.
2. Leia `AGENTS.md` e a skill Trigger adequada antes de modificar tarefas.
3. Corrija chamadores e deixe teste pequeno para lógica nova. Teste conforme a mudança:

```sh
npm run check
npm run typecheck:strict
npm run workflow -- bid --date 2026-07-28 --fixture test-fixtures/bid.json
npm run workflow -- overdue --date 2026-07-28 --fixture test-fixtures/overdue.json
```

4. Quando houver pedido de teste integrado, inicie o servidor dev e dispare o
   payload explícito em `dev`. Espere a conclusão quando o resultado foi solicitado.
5. Para deploy solicitado, confira o diff, os testes e as credenciais de produção.
   Publicação usa o código local; não requer push prévio, mas push não substitui deploy.

```sh
npx -y trigger.dev@4.5.16 deploy --env prod --skip-update-check
```

6. Espere o deploy completar e confirme `get_current_worker` em `prod`. Guarde
   versão e URL. Não anunciar sucesso só porque os arquivos foram enviados.
7. Não execute tarefas normais automaticamente após o deploy: publicar e disparar
   mensagens/lances são ações distintas. Um pedido explícito pode autorizar ambas.
8. Atualize o estado/documentação quando a mudança for publicada ou a regra mudar.
   Só faça commit/push quando solicitado ou incluído no escopo do trabalho.

## Agendamentos fixos e capacidade dinâmica

O SDK instalado suporta uma data exata em `delay` e `runs.reschedule` para uma
execução ainda pendente. `schedules.create` configura recorrência e exige uma
task definida com `schedules.task`. Isso não significa que nosso planejador já existe.

A decisão vigente usa crons fixos em `src/trigger/monthly-schedules.ts`:
ofertas dias 1 e 15; lances dias 6, 14 e 18 para vencimentos 8, 16 e 20.
Horário nominal 09:00 São Paulo; sincronização de grupos dias 1 e 15 às 07:00.
Novos crons exclusivos de produção. A sincronização anterior às ofertas não
bloqueia seu envio se houver falha; conferir idade das seções e logs de grupos.
Não implementar o planejador mensal anterior: foi substituído por essa decisão.
O cron é registrado no deploy; a run aparece em cada ocorrência, sem deixar
uma run `DELAYED` por cliente. Conferir no painel o cron, ambiente, estado ativo,
`nextRun` e horário efetivo (o plano pode aplicar janela). Os wrappers validam a
data nominal contra o dia atual e usam chave global por data; o filho de lances
continua protegendo contrato/mês e exigindo confirmação gerencial.
Para recuperar uma data perdida, investigar os logs e usar a tarefa original
com payload explícito; não alterar timestamps do wrapper para forçar reenvio.
Novos vencimentos exigem ampliar o cron e a seleção, com teste. A auditoria de
29/10 cruzou 48 contratos em 13 grupos com calendários até junho/2027; lances
nas datas fixas ficariam de 6 a 12 dias antes das assembleias. Isso não comprova
o prazo de encerramento de lances no portal. Ofertas do dia 15 não são aplicadas
automaticamente ao lote já processado no dia 14.

## Limites de diagnóstico

O banco atual pode ter sido atualizado depois do envio; não atribua ao registro
histórico o valor que só aparece hoje. Nem toda tabela mantém versões anteriores.
Não afirmar quando um campo mudou sem evidência. Dados do portal podem estar
defasados ou incompletos por seção. Ao precisar repetir uma operação mutável,
confira antes se o efeito ocorreu e preserve idempotência/confirmacão gerencial.
