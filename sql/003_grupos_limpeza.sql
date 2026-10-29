-- Etapa 2: somente depois do deploy novo e da task groups-sync popular/validar TODOS os grupos.
-- Preservar backup local antes de executar. Nenhuma tabela do Daily Sync e alterada.
BEGIN;
LOCK TABLE public.grupos IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.grupos
    WHERE regras_assembleias IS NULL OR taxas_administracao IS NULL
      OR jsonb_typeof(regras_assembleias) <> 'array'
      OR jsonb_typeof(taxas_administracao) <> 'array'
      OR jsonb_array_length(regras_assembleias) = 0
      OR jsonb_array_length(taxas_administracao) = 0
  ) THEN
    RAISE EXCEPTION 'Limpeza bloqueada: ha grupos sem regras/taxas estruturadas. Executar e revisar groups-sync antes.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.grupos g
    WHERE NOT EXISTS (
      SELECT 1 FROM public.grupos_sincronizacoes s
      WHERE s.nr_grupo = g.nr_grupo AND s.status = 'sucesso'
        AND s.finalizado_em >= g.updated_at
        AND s.resultado_secoes->'regras_assembleias'->>'status' = 'ok'
        AND s.resultado_secoes->'taxas_administracao'->>'status' = 'ok'
    )
  ) THEN
    RAISE EXCEPTION 'Limpeza bloqueada: falta coleta bem-sucedida da nova groups-sync para algum grupo.';
  END IF;
END $$;
ALTER TABLE public.grupos
  DROP COLUMN IF EXISTS previsao_reajuste,
  DROP COLUMN IF EXISTS planos,
  DROP COLUMN IF EXISTS historico_lances,
  DROP COLUMN IF EXISTS regras_texto,
  DROP COLUMN IF EXISTS contemplados_sorteio,
  DROP COLUMN IF EXISTS contemplados_lance,
  DROP COLUMN IF EXISTS ultima_visualizacao_em,
  DROP COLUMN IF EXISTS atualizacao_secoes,
  DROP COLUMN IF EXISTS created_at;
NOTIFY pgrst, 'reload schema';
COMMIT;
