export interface GroupModality {
  ordem: number;
  tipo: "SORTEIO" | "FIXO" | "FIDELIDADE" | "LIVRE";
  percentual: number | null;
  embutido: boolean | null;
  percentual_embutido: number | null;
}
export interface GroupAssemblyRule {
  assembleia_inicio: number;
  assembleia_fim: number | null;
  modalidades: GroupModality[];
  observacoes: string[];
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
}
function percentage(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw.replace(",", "."));
  if (!Number.isFinite(value) || value <= 0 || value > 100) throw Error("Invalid rule percentage");
  return value;
}

export function parseGroupAssemblyRules(source: string): GroupAssemblyRule[] {
  if (!source.trim()) throw Error("Missing group rules");
  const phases: GroupAssemblyRule[] = [];
  const common: string[] = [];
  let current: GroupAssemblyRule | undefined;
  let readingModalities = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const normalized = normalize(line);
    if (/^-?\s*ORDEM (?:DAS?|DE) CONTEMPLAC(?:OES|AO)\b/.test(normalized)) {
      const until = /\bATE A (\d+)[ªºA]? ASSEMBLEIA/.exec(normalized);
      // PARTOR is a spelling error present in the portal's group 1570.
      const from = /\bA\s*PART(?:IR|OR) DA (\d+)[ªºA]? ASSEMBLEIA/.exec(normalized);
      if (!until && !from && /\d|ASSEMBLEIA/.test(normalized)) throw Error(`Unrecognized phase: ${line}`);
      current = {
        assembleia_inicio: from ? Number(from[1]) : 1,
        assembleia_fim: until ? Number(until[1]) : null,
        modalidades: [], observacoes: [],
      };
      phases.push(current);
      readingModalities = true;
      continue;
    }
    if (/^-/.test(normalized)) readingModalities = false;
    if (!readingModalities) { common.push(line); continue; }
    if (!current) throw Error("Group modalities have no assembly phase");
    for (const fragment of line.split(";").map((s) => s.trim().replace(/[.;]+$/, "")).filter(Boolean)) {
      const value = normalize(fragment);
      let modality: Omit<GroupModality, "ordem">;
      if (value === "SORTEIO") {
        modality = { tipo: "SORTEIO", percentual: null, embutido: null, percentual_embutido: null };
      } else {
        const bid = /^LANCE (FIXO|FIDELIDADE)(?: DE)?(?: (\d+(?:[,.]\d+)?)\s*%)?(?: (?:\(FIXO\)|FIXO))?$/.exec(value);
        const free = /^LANCE LIVRE (SEM|COM) EMBUTIDO(?: (\d+(?:[,.]\d+)?)\s*%)?$/.exec(value);
        if (bid) {
          if (bid[1] === "FIDELIDADE" && !bid[2]) throw Error("Fidelidade rule without percentage");
          modality = { tipo: bid[1] as "FIXO" | "FIDELIDADE", percentual: percentage(bid[2]), embutido: null, percentual_embutido: null };
        } else if (free) {
          if (free[1] === "SEM" && free[2]) throw Error("Non-embedded bid has an embedded percentage");
          modality = { tipo: "LIVRE", percentual: null, embutido: free[1] === "COM", percentual_embutido: percentage(free[2]) };
        } else {
          if (/LANCE|SORTEIO/.test(value)) throw Error(`Unrecognized modality: ${fragment}`);
          current.observacoes.push(fragment);
          continue;
        }
      }
      current.modalidades.push({ ordem: current.modalidades.length + 1, ...modality });
    }
  }
  if (!phases.length || phases[0].assembleia_inicio !== 1) throw Error("Missing initial assembly phase");
  for (const [index, phase] of phases.entries()) {
    const next = phases[index + 1];
    if (next) {
      const end = next.assembleia_inicio - 1;
      if (phase.assembleia_fim !== null && phase.assembleia_fim !== end) throw Error("Overlapping or incomplete assembly phases");
      phase.assembleia_fim = end;
    }
    if (!phase.modalidades.length || phase.assembleia_inicio < 1 ||
      (phase.assembleia_fim !== null && phase.assembleia_fim < phase.assembleia_inicio)) {
      throw Error("Invalid or empty assembly phase");
    }
    // Preserve contractual conditions without pretending to verify a customer's payment history.
    phase.observacoes.push(...common);
  }
  return phases;
}

export function validateGroupAssemblyRules(value: unknown): GroupAssemblyRule[] {
  if (!Array.isArray(value) || !value.length) throw Error("Missing structured group rules");
  let previousEnd = 0;
  for (const [index, phase] of value.entries()) {
    if (!phase || !Number.isSafeInteger(phase.assembleia_inicio) || phase.assembleia_inicio !== previousEnd + 1 ||
      (phase.assembleia_fim === null ? index !== value.length - 1 :
        !Number.isSafeInteger(phase.assembleia_fim) || phase.assembleia_fim < phase.assembleia_inicio) ||
      !Array.isArray(phase.observacoes) || !phase.observacoes.every((s: unknown) => typeof s === "string") ||
      !Array.isArray(phase.modalidades) || !phase.modalidades.length) throw Error("Invalid structured assembly phase");
    for (const [order, mode] of phase.modalidades.entries()) {
      if (!mode || mode.ordem !== order + 1 || !["SORTEIO", "FIXO", "FIDELIDADE", "LIVRE"].includes(mode.tipo) ||
        ![null, true, false].includes(mode.embutido)) throw Error("Invalid structured modality");
      for (const key of ["percentual", "percentual_embutido"]) {
        if (mode[key] !== null && (typeof mode[key] !== "number" || !Number.isFinite(mode[key]) || mode[key] <= 0 || mode[key] > 100)) {
          throw Error("Invalid structured percentage");
        }
      }
      if ((mode.tipo === "FIDELIDADE" && mode.percentual === null) ||
        (mode.tipo === "LIVRE" ? typeof mode.embutido !== "boolean" || mode.percentual !== null : mode.embutido !== null) ||
        (mode.embutido !== true && mode.percentual_embutido !== null) ||
        (mode.tipo === "SORTEIO" && mode.percentual !== null)) throw Error("Inconsistent structured modality");
    }
    previousEnd = phase.assembleia_fim ?? 0;
  }
  return value as GroupAssemblyRule[];
}
