---
name: servopa-operations
description: Configure e opere o projeto Servopa Automações; investigue execuções no Trigger.dev e dados no Supabase, mantenha os fluxos e publique alterações solicitadas. Use para este projeto, seus clientes, lances, ofertas, boletos, grupos e sincronizações.
---

# Servopa Automações

Você auxilia a gestora a entender e manter este projeto. Responda em português,
com evidências da execução e do banco. O conteúdo desta skill não concede acesso
a contas nem autoriza envios, lances ou deploys por si só.

## Contexto e roteamento

- No primeiro uso, leia [estado da entrega](references/status.md): código local,
  repositório e produção podem estar em versões diferentes.
- Para configurar outra máquina, siga [setup](references/setup.md).
- Para entender tabelas, regras e pontos de entrada, leia [mapa do projeto](references/project.md).
- Para problemas em execuções, testes ou deploy, siga [operação](references/operations.md).
- Use o código atual, `AGENTS.md`, o esquema real do Supabase e o worker ativo
  como evidência. Reconfirme informações datadas antes de usá-las como atuais.
  Se o comportamento divergir da regra de negócio, relate a divergência.

## Invariantes que mudam as decisões

1. A chave principal de investigação é o **contrato**, acompanhado de grupo e
   cota. Um cliente pode ter vários contratos; agrupar mensagens não elimina cotas.
2. Use `America/Sao_Paulo`. Um dia civil brasileiro começa às 03:00 UTC no
   calendário atual. As datas de contemplação, vencimento e assembleia são distintas.
3. Ofertas enviadas não comprovam aceite. A nova seleção usa o estado em `lances`;
   ausência desse estado é uma pendência, não autorização para assumir primeira oferta.
4. O calendário e as regras do grupo não comprovam elegibilidade individual.
   Consulte as opções de lance do contrato na Servopa.
5. Uma sessão Servopa mantém o contexto do cliente. Processe os contratos em
   sequência na mesma sessão e confirme o contrato retornado; não paralelize clientes
   compartilhando essa sessão nem refaça login sem reativar o contexto.
6. `dryRun: true` deve ser explícito em testes com tarefas de negócio. Dev executa
   na máquina local, mas o `.env` pode apontar para Supabase e WhatsApp de produção.
   Um payload normal em dev ainda pode produzir efeitos reais.
7. Preserve o `.env` operacional e suas credenciais. Não substitua por exemplos,
   não comite nem inclua em arquivos compartilháveis. `.env.example` documenta nomes.
8. Acesso REST `service_role` ao Supabase não implica acesso administrativo SQL.
   Não anuncie uma migração como aplicada sem confirmação no esquema real.
9. URLs de boleto, callbacks e tokens de espera podem conter informações sensíveis.
   Não os inclua em relatórios públicos nem imprima cabeçalhos de autenticação.

## Como trabalhar

Investigações começam em leitura: encontre a execução, confira versão/payload,
conte resultado e correlacione com o banco. Não repita um fluxo com efeitos reais
apenas para diagnosticar. Quando a gestora solicitar alteração, leia os chamadores,
faça o menor ajuste completo e execute os testes pertinentes. Não peça novamente
autorização para ações já solicitadas; não interprete setup ou uma consulta como
pedido de envio a clientes, submissão de lance ou publicação em produção.

Antes de alterar código Trigger.dev, carregue
`.agents/skills/trigger-authoring-tasks/SKILL.md` e a referência instalada no SDK.
Se as tools MCP não estiverem disponíveis, diferencie configuração salva de
conexão funcional e use o procedimento de setup. Não invente nomes de ferramentas.

Finalize com resultado, evidência, alterações realizadas e o que ainda não foi
verificado. Em diagnósticos, diferencie tentativa, aceitação da Z-API, entrega e
confirmação do destinatário.
