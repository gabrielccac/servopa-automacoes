BEGIN;

CREATE TABLE public.grupos (
  nr_grupo integer PRIMARY KEY CHECK (nr_grupo > 0),
  segmento text CHECK (segmento IN ('M', 'I')),
  prazo_total_meses integer CHECK (prazo_total_meses > 0),
  vagas_disponiveis integer CHECK (vagas_disponiveis >= 0),
  numero_consorciados integer CHECK (numero_consorciados >= 0),
  contemplados_sorteio integer CHECK (contemplados_sorteio >= 0),
  contemplados_lance integer CHECK (contemplados_lance >= 0),
  dia_vencimento smallint CHECK (dia_vencimento BETWEEN 1 AND 31),
  percentual_embutido numeric(9,4) CHECK (percentual_embutido BETWEEN 0 AND 100),
  percentual_fundo_reserva numeric(9,4) CHECK (percentual_fundo_reserva BETWEEN 0 AND 100),
  percentual_seguro numeric(9,4) CHECK (percentual_seguro BETWEEN 0 AND 100),
  tipo_sorteio text,
  tipo_seguro text,
  tipo_grupo text,
  proxima_assembleia_numero integer CHECK (proxima_assembleia_numero > 0),
  proxima_assembleia_em timestamptz,
  previsao_reajuste date,
  regras_texto text,
  planos jsonb CHECK (jsonb_typeof(planos) = 'array'),
  assembleias jsonb CHECK (jsonb_typeof(assembleias) = 'array'),
  historico_lances jsonb CHECK (jsonb_typeof(historico_lances) = 'array'),
  disponivel boolean,
  ultima_visualizacao_em timestamptz,
  atualizacao_secoes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(atualizacao_secoes) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- No foreign key: a failed first extraction must also be recorded.
CREATE TABLE public.grupos_sincronizacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nr_grupo integer NOT NULL CHECK (nr_grupo > 0),
  trigger_run_id text,
  status text NOT NULL CHECK (status IN ('sucesso', 'parcial', 'falha')),
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  finalizado_em timestamptz,
  resultado_secoes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(resultado_secoes) = 'object'),
  erro text,
  CHECK (finalizado_em IS NULL OR finalizado_em >= iniciado_em)
);

CREATE INDEX grupos_sincronizacoes_grupo_data_idx
  ON public.grupos_sincronizacoes (nr_grupo, iniciado_em DESC);

COMMENT ON COLUMN public.grupos.percentual_embutido IS 'Percentual em pontos: 30 representa 30%, nao 0.30. A mesma unidade vale para os demais percentuais.';
COMMENT ON COLUMN public.grupos.planos IS 'NULL: ainda nao coletado. []: coleta completa sem itens. Itens incluem categoria, descricao, taxa_administracao, prazo_meses, valor_credito, percentual_mensal, parcela_sem_seguro, seguro, observacao, parcela_total, disponivel e ultima_visualizacao_em.';
COMMENT ON COLUMN public.grupos.assembleias IS 'Lista de numero, data, horario, local, cidade e situacao. Datas ISO e horario local America/Sao_Paulo.';
COMMENT ON COLUMN public.grupos.historico_lances IS 'Lista de assembleia_numero, data, modalidade (com_embutido ou sem_embutido), maior_lance, menor_lance e quantidade. Preservar registros anteriores quando a fonte nao fornecer historico.';
COMMENT ON COLUMN public.grupos.atualizacao_secoes IS 'Objeto com timestamps ISO por secao; historico_com_embutido e historico_sem_embutido possuem atualizacoes independentes.';
COMMENT ON COLUMN public.grupos.updated_at IS 'A integracao deve atualizar este campo em cada escrita; o DEFAULT aplica-se apenas a insercao.';

ALTER TABLE public.grupos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grupos_sincronizacoes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.grupos, public.grupos_sincronizacoes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.grupos, public.grupos_sincronizacoes TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
