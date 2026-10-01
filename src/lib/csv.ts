export type CsvRow = Record<string, string>;

function normalizeCell(value: string): string {
  return String(value).replace(/\r/g, "").trim();
}

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === "\"") {
      if (inQuotes && nextCharacter === "\"") {
        current += "\"";
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (character === delimiter && !inQuotes) {
      values.push(normalizeCell(current));
      current = "";
      continue;
    }

    current += character;
  }

  values.push(normalizeCell(current));
  return values;
}

function parseDelimitedCsv(text: string, delimiter: string): CsvRow[] {
  const normalizedText = String(text || "").replace(/^\uFEFF/, "");
  const lines = normalizedText
    .split("\n")
    .map((line) => line.replace(/\r/g, ""))
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return [];
  }

  const headers = parseDelimitedLine(lines[0], delimiter);
  const rows: CsvRow[] = [];

  for (const line of lines.slice(1)) {
    const values = parseDelimitedLine(line, delimiter);
    const row: CsvRow = {};

    for (let index = 0; index < headers.length; index++) {
      row[headers[index]] = normalizeCell(values[index] ?? "");
    }

    rows.push(row);
  }

  return rows;
}

export function parseSemicolonCsv(text: string): CsvRow[] {
  return parseDelimitedCsv(text, ";");
}

export function parseCommaCsv(text: string): CsvRow[] {
  return parseDelimitedCsv(text, ",");
}
