# Prompt para o agente da gestora

Copie a mensagem abaixo para um agente com acesso a arquivos e terminal na máquina
da gestora. Código, skill e guias estão no
[GitHub](https://github.com/gabrielccac/servopa-automacoes).
As credenciais reais precisam ser configuradas localmente por canal seguro;
não estão no repositório. Não é necessário enviar ZIP.

---

Quero que você configure este projeto Servopa Automações na minha máquina e passe
a me ajudar a manter o código e investigar execuções do Trigger.dev e do Supabase.

Clone ou atualize o repositório https://github.com/gabrielccac/servopa-automacoes.
Use a skill `$servopa-operations`, já presente em
`.agents/skills/servopa-operations/SKILL.md`, mantendo `references/` e `scripts/`
juntos. Leia primeiro o estado da entrega e o guia de setup referenciados na skill.
Consulte também a documentação operacional no Notion:
https://app.notion.com/p/35d8271577b980808fa2eddfcf21333e.
O guia de entrada para agentes está em
https://app.notion.com/p/4088271577b981daadd2e0ae63f2cb36.
Se não tiver acesso ao Notion, continue pelos guias versionados do repositório
e registre a pendência de acesso.

Realize o setup de ponta a ponta dentro do que os acessos disponíveis permitirem:

1. Localize ou crie o checkout correto de `gabrielccac/servopa-automacoes`, preserve
   trabalho existente e confira branch e commit. GitHub é a fonte de distribuição
   do código; a versão ativa no Trigger pode ser anterior ao código da branch.
2. Confira Git/Node/npm, instale as dependências pelo lockfile e execute os testes.
3. Configure o MCP do Trigger para `proj_wmgnkaivkyvudwfshcad`, com a minha conta
   autorizada. Valide a conexão com uma chamada real, verificando o worker em produção.
4. Preserve meu `.env` se existir. Se faltarem credenciais, informe os nomes e como
   configurá-las localmente, sem pedir que eu cole segredos no chat. Não copie o
   perfil pessoal ou tokens de Gabriel. Ajude com o login interativo quando necessário.
5. Execute o diagnóstico de leitura do Supabase incluído na skill. Não crie,
   altere ou popule tabelas apenas para testar o acesso. Diferencie REST de acesso SQL.
6. Configure a descoberta desta skill e das skills Trigger já presentes no projeto,
   para que futuras dúvidas não dependam de eu repetir todo o contexto.
7. Gere um relatório final do setup: pasta, versão do código/SDK, identidade e
   projeto Trigger, conexão MCP testada, leituras do Supabase e testes locais.
   Declare quais acessos ainda precisam ser concedidos, se houver.

Não publique em produção, não dispare mensagens, não registre lances e não crie
agendamentos durante esse setup. Se for útil testar uma tarefa de negócio, use
somente `dev` com `dryRun: true` explícito após validar as configurações.

Depois do setup, atue como assistente técnico da operação. Para minhas dúvidas,
consulte runs e dados reais, apresente contratos/status/motivos e aponte limitações
da evidência. Quando eu solicitar alterações de código, faça a implementação e
os testes; quando eu solicitar publicação, faça o deploy e confirme a versão ativa.
Não trate mensagens de oferta enviadas como aceites de cliente e não presuma que
um lance sem registro já está autorizado. Os desconhecidos permanecem em revisão
até eu orientar outra regra.

---

O agente não consegue conceder a si mesmo acesso a contas. A gestora precisa dos
convites e credenciais apropriados. O setup deve avançar nas partes independentes
e reportar pendências objetivas, sem anunciar integrações não verificadas.
