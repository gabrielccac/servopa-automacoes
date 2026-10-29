-- Etapa 1: aplicar antes do deploy. Nao remove dados nem altera as bases do Daily Sync.
BEGIN;
ALTER TABLE public.grupos
  ADD COLUMN IF NOT EXISTS regras_assembleias jsonb
    CHECK (regras_assembleias IS NULL OR jsonb_typeof(regras_assembleias) = 'array'),
  ADD COLUMN IF NOT EXISTS taxas_administracao jsonb
    CHECK (taxas_administracao IS NULL OR jsonb_typeof(taxas_administracao) = 'array');

COMMENT ON COLUMN public.grupos.regras_assembleias IS 'Faixas inclusivas: assembleia_inicio, assembleia_fim (NULL: sem limite), modalidades em ordem e observacoes. Percentuais em pontos; regras do grupo nao comprovam elegibilidade individual.';
COMMENT ON COLUMN public.grupos.taxas_administracao IS 'Taxas de administracao por categoria, descricao, prazo_meses, prazo_original_meses e valor_credito. percentual em pontos. Nao e uma taxa unica por grupo.';
COMMENT ON COLUMN public.grupos.updated_at IS 'Ultima gravacao do grupo; consultar grupos_sincronizacoes para sucesso/falha de cada secao.';

CREATE OR REPLACE VIEW public.grupos_regras_assembleias
WITH (security_invoker = true) AS
SELECT g.nr_grupo,
  (f.value->>'assembleia_inicio')::integer AS assembleia_inicio,
  (f.value->>'assembleia_fim')::integer AS assembleia_fim,
  (m.value->>'ordem')::integer AS ordem,
  m.value->>'tipo' AS modalidade,
  (m.value->>'percentual')::numeric AS percentual,
  (m.value->>'embutido')::boolean AS embutido,
  (m.value->>'percentual_embutido')::numeric AS percentual_embutido,
  f.value->'observacoes' AS observacoes
FROM public.grupos g
CROSS JOIN LATERAL jsonb_array_elements(g.regras_assembleias) f
CROSS JOIN LATERAL jsonb_array_elements(f.value->'modalidades') m;

REVOKE ALL ON public.grupos_regras_assembleias FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.grupos_regras_assembleias TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
