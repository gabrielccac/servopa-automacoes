# Setup na máquina da gestora

Objetivo: editar o código correto, consultar Trigger/Supabase e executar testes.
O setup não deve iniciar fluxos com efeitos reais nem publicar código automaticamente.
Não pressupor que a nova máquina tem os caminhos, credenciais ou conta de Gabriel.

## 1. Código e ferramentas

1. Escolha uma pasta de trabalho nova ou inspecione a existente antes de alterá-la.
2. Instale/verifique Git, Node.js 22 LTS e npm. Python 3 com `venv` é necessário
   para os scripts de diagnóstico Python; a extensão Python também integra o build remoto.
3. Confira o repositório e o commit. A branch de trabalho deve preservar
   alterações existentes. GitHub pode exigir login/permissão de colaboradora para push.

```sh
git clone https://github.com/gabrielccac/servopa-automacoes.git
cd servopa-automacoes
git switch -c codex/setup-gestora
```

Código, skill e guias são distribuídos pelo GitHub, sem sobreposição de ZIP.
Em um checkout existente, faça `git fetch origin`, confira o estado e concilie
alterações locais antes de atualizar a branch. Não crie um segundo repositório
remoto; o destino oficial já existe. Anote o commit usado no setup.

```sh
npm ci
npm run check
npm run typecheck:strict
```

O SDK e o build estão fixados em **4.5.16** no projeto. Use a mesma versão do CLI
para dev/deploy, sem aceitar atualização automática de dependências do projeto:

```sh
npx -y trigger.dev@4.5.16 --help
```

O checkout já contém `servopa-operations` em `.agents/skills/`. Outros clientes
podem usar seu diretório próprio de skills; copie a pasta completa apenas se necessário.
`SKILL.md` e `references/` devem permanecer juntos. Não duplique a skill globalmente
se a descoberta no projeto já funciona.

## 2. Credenciais e `.env`

Se `.env` já existe, preserve-o. Se não existe, copie `.env.example` e obtenha os
valores por canal seguro com o responsável. Não coloque credenciais em conversa,
prompt, skill, screenshot, commit ou ZIP. O repositório não contém esses valores.

| Integração | Variáveis | Finalidade |
|---|---|---|
| Servopa | `SERVOPA_CPF_CNPJ`, `SERVOPA_SENHA` | Login no portal |
| Supabase principal | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Dados operacionais |
| Supabase complementar | `ALT_SUPABASE_URL`, `ALT_SUPABASE_SERVICE_ROLE_KEY` | Aniversários e verificação de ativos |
| WhatsApp | `ZAPI_BASE_URL`, `ZAPI_INSTANCE_ID`, `ZAPI_INSTANCE_TOKEN`, `ZAPI_CLIENT_TOKEN` | Envios reais quando solicitados |
| Resumo | `ZAPI_EXECUTION_SUMMARY_PHONE` | Destino do resumo operacional |
| Revisão de lances | `SUBMIT_BID_MANAGER_PHONE`, `SUBMIT_BID_REVIEW_WEBHOOK_URL` | Confirmação gerencial externa |
| Diagnóstico/envio de teste | `ZAPI_TEST_*` | O script `send-offer-reply-test.ts` envia mensagem real |
| Entrega | `ZAPI_DELIVERY_WEBHOOK_RESTORE_URL`, `ZAPI_DELIVERY_WAIT_TIMEOUT` | Fluxos de confirmação de entrega |

O `getConfig()` atual valida Servopa, Supabase e Z-API em conjunto; um erro de
variável Z-API pode aparecer mesmo em uma rotina de leitura. Não resolver isso
inserindo valores fictícios no ambiente operacional. Os testes unitários têm
fixtures próprias, apenas no processo do teste.

O Supabase principal esperado é `umvldqzzliqmgkvoedyd.supabase.co`; o complementar,
`kwimrjvgingabctgegvl.supabase.co`. Alterações legítimas de projeto precisam ser
confirmadas pelo responsável. A chave `service_role` é privilegiada e não impõe
somente leitura. Para um agente exclusivamente consultivo, pode-se provisionar
acesso limitado; para manter este backend, siga o acesso efetivamente concedido.

Não há necessidade de MCP Supabase para operar a integração existente: use o REST
do projeto. Um MCP Supabase é opcional e precisa de autenticação própria. `service_role`
não é token de gestão nem senha PostgreSQL. SQL exige acesso adicional ou execução
manual no painel. Não rodar novamente `sql/001_grupos.sql` se as tabelas já existem.
Para a revisão dos grupos em JSONB, conferir a pendência em `status.md` e seguir
as etapas do README (SQL 002, backfill, deploy/coleta, SQL 003). Não aplicar a
limpeza durante setup nem publicar código dependente de colunas ainda inexistentes.

## 3. Trigger.dev: conta e MCP

O responsável deve conceder à gestora acesso à organização/projeto com as funções
necessárias. Faça login na conta dela pelo navegador; não copie o cache de tokens
ou o perfil pessoal de outra máquina.

```sh
npx -y trigger.dev@4.5.16 login
npx -y trigger.dev@4.5.16 whoami
```

Configure o MCP pelo cliente. No Codex, verifique primeiro `codex mcp get trigger --json`.
Se não estiver cadastrado:

```sh
codex mcp add trigger -- npx -y trigger.dev@latest mcp --project-ref proj_wmgnkaivkyvudwfshcad
```

Configuração equivalente, ajustando **somente** a seção correspondente no arquivo
do cliente; substitua o caminho pelo checkout real e não sobrescreva outras seções:

```toml
[mcp_servers.trigger]
command = "npx"
args = ["-y", "trigger.dev@latest", "mcp", "--project-ref", "proj_wmgnkaivkyvudwfshcad"]
cwd = "CAMINHO_ABSOLUTO_DO_CHECKOUT"
startup_timeout_sec = 90.0
```

O CLI do MCP pode ser mais novo que o SDK. Isso não é motivo para atualizar o SDK
do backend. Não use caminhos temporários do cache npm de Gabriel na nova máquina.
Reinicie a conexão MCP no aplicativo após configurar. Descubra as ferramentas da
sessão e teste `whoami`/`get_current_worker` em `prod`, seguido de `list_runs`.
Os nomes expostos pelo host podem ter prefixos diferentes.

Configuração habilitada no arquivo não comprova conexão. A confirmação é uma
chamada bem-sucedida ao projeto correto. Se as ferramentas não aparecerem nesta
conversa, registre o problema e use a reinicialização do cliente; não diga que
estão disponíveis apenas porque a configuração foi salva.

## 4. Verificação de leitura do banco

Na raiz do checkout, execute:

```sh
node .agents/skills/servopa-operations/scripts/check-setup.mjs
```

Esse diagnóstico usa apenas HEAD no REST, não lê linhas de clientes e não testa
gravação. Ele carrega `.env` localmente, verifica nomes de variáveis e consulta
as tabelas sem imprimir valores secretos. Ausência de credenciais é pendência,
não permissão para inventá-las. HTTP 200 comprova a leitura consultada, não acesso SQL.

## 5. Teste de desenvolvimento

Só depois dos testes locais e das credenciais corretas:

```sh
npx -y trigger.dev@4.5.16 dev --skip-update-check --env-file .env
```

Espere a confirmação de worker local pronto. Pelo MCP, dispare **em `dev`**
`offer-reminder` com `{ "dryRun": true }`, acompanhe a conclusão e leia `sendPlan`,
`groupConfigs`, `skipReasons`, `results`, `sentMessageCount` e `reminderLogCount`.
Os dois últimos devem ser zero. Esse teste ainda consulta dados reais e a Servopa.
Encerre o servidor dev depois de concluir a verificação, a menos que seja útil
mantê-lo aberto por solicitação da gestora.

Não use `daily-orchestrator` normal nem `submit-bid` normal como teste de conexão.
Não execute `send-offer-reply-test.ts` para testar uma instalação.

## Resultado esperado do setup

Informe a pasta do checkout, versão do SDK, identidade Trigger verificada,
projeto/ambiente, teste real do MCP, status das tabelas e resultado dos testes.
Liste separadamente convites, logins, credenciais ou acesso SQL ainda necessários.
Configuração não equivale a produção publicada: confirme o worker antes de afirmar isso.

Referências oficiais:
- https://trigger.dev/docs/mcp-introduction
- https://trigger.dev/docs/cli-login-commands
- https://developers.openai.com/codex/mcp
- https://supabase.com/docs/guides/api/api-keys
