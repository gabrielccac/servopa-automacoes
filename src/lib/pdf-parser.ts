import { extractText, getDocumentProxy } from "unpdf";

export interface InadimplenteRecord {
  nr_cota: string;
  nr_contrato: string;
  nm_consorciado: string;
  source_phone: string;
  qt_pgo: number | null;
  qt_atr: number | null;
  vl_percent_mensal: number | null;
  vl_percent_difer: number | null;
  vl_atraso: number | null;
}


function parseNum(v: string | undefined): number | null {
  if (!v) return null;
  try {
    return parseFloat(v.replace(/\./g, "").replace(",", "."));
  } catch {
    return null;
  }
}

export function parseInadimplentesText(text: string): InadimplenteRecord[] {
  const results: InadimplenteRecord[] = [];
  const cotaPattern = /\d{4}\.\d{4}-\d/g;
  const matches = [...text.matchAll(cotaPattern)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const startIdx = match.index!;
    const endIdx = i < matches.length - 1 ? matches[i + 1].index! : text.length;
    const line = text.substring(startIdx, endIdx).trim();

    const parts = line.split(/\s+/);
    if (parts.length < 8) continue;

    const cota = parts[0];
    const contrato = parts[1];

    let phoneEndIdx = -1;
    for (let j = 2; j < parts.length; j++) {
      if (/^\d{2}$/.test(parts[j]) && /^\d{4,5}\.?\d{4}$/.test(parts[j + 1])) {
        phoneEndIdx = j + 1;
        break;
      }
    }

    if (phoneEndIdx === -1) continue;

    const name = parts.slice(3, phoneEndIdx - 1).join(" ");
    const phone = `${parts[phoneEndIdx - 1]} ${parts[phoneEndIdx]}`;
    const lastFive = parts.slice(phoneEndIdx + 1);

    if (lastFive.length < 5) continue;

    results.push({
      nr_cota: cota,
      nr_contrato: contrato,
      nm_consorciado: name,
      source_phone: phone,
      qt_pgo: parseNum(lastFive[0]),
      qt_atr: parseNum(lastFive[1]),
      vl_percent_mensal: parseNum(lastFive[2]),
      vl_percent_difer: parseNum(lastFive[3]),
      vl_atraso: parseNum(lastFive[4]),
    });
  }

  return results;
}

export async function parseInadimplentesPdf(pdfBuffer: Buffer): Promise<InadimplenteRecord[]> {
  const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer), {
    useWasm: false,
    isImageDecoderSupported: false,
    verbosity: 0,
  });

  try {
    const { text } = await extractText(pdf, {
      mergePages: true,
    });

    return parseInadimplentesText(text);
  } finally {
    await pdf.destroy();
  }
}
