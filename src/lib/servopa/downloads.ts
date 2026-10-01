import { HttpClient } from "./http-client.js";

const BASE_URL = "https://www.consorcioservopa.com.br";
const DOWNLOADS_AJAX_PATH = "/vendas/_app/downloads.ajax.php";
const DOWNLOADS_POLL_INTERVAL_MS = 5_000;
const DOWNLOADS_POLL_MAX_ATTEMPTS = 12;

export interface DiscoveredDownloadFile {
  fileName: string;
  fileDate: string;
  fileUrl: string;
  source?: "cached" | "generated";
}

export function parseFileTable(html: string): DiscoveredDownloadFile[] {
  const files: DiscoveredDownloadFile[] = [];
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    const tds = row.match(/<td>[\s\S]*?<\/td>/gi);
    if (!tds || tds.length < 3) continue;

    const fileNameMatch = tds[0].match(/<div class="wrap">([\s\S]*?)<\/div>/i);
    const fileDateMatch = tds[1].match(/<td>([\s\S]*?)<\/td>/i);
    const fileUrlMatch = tds[2].match(/href="([^"]+)"/i);

    if (fileNameMatch && fileDateMatch && fileUrlMatch) {
      const href = fileUrlMatch[1].trim();
      files.push({
        fileName: fileNameMatch[1].trim(),
        fileDate: fileDateMatch[1].trim(),
        fileUrl: href.startsWith("http")
          ? href
          : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`,
      });
    }
  }

  return files;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getTodayBrtText(date = new Date()): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function findTodayDownload(
  files: DiscoveredDownloadFile[],
  todayBrt: string,
  fileNameIncludes: string
): DiscoveredDownloadFile | undefined {
  return files.find(
    (file) => file.fileDate.startsWith(todayBrt) && file.fileName.toUpperCase().includes(fileNameIncludes)
  );
}

export async function fetchOrGenerateDownload(
  client: HttpClient,
  options: {
    fileNameIncludes: string;
    triggerPayload: {
      dt_ini: string;
      dt_fin: string;
      grupo: string;
      ano: string;
      categoria: string;
    };
  }
): Promise<DiscoveredDownloadFile> {
  const todayBrt = getTodayBrtText();

  const downloadsResp = await client.get("/vendas/downloads");
  if (!downloadsResp.ok) {
    throw new Error(`Failed to fetch downloads - HTTP ${downloadsResp.status}`);
  }

  const downloadsHtml = await downloadsResp.text();
  const existingDownload = findTodayDownload(parseFileTable(downloadsHtml), todayBrt, options.fileNameIncludes);
  if (existingDownload) {
    return {
      ...existingDownload,
      source: "cached",
    };
  }

  console.log(`Generating ${options.fileNameIncludes} download for today...`);
  const triggerResp = await client.postJson(DOWNLOADS_AJAX_PATH, options.triggerPayload);

  if (!triggerResp.ok) {
    throw new Error(`Failed to trigger downloads generation - HTTP ${triggerResp.status}`);
  }

  console.log(`Polling downloads for ${options.fileNameIncludes}...`);
  for (let attempt = 1; attempt <= DOWNLOADS_POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(DOWNLOADS_POLL_INTERVAL_MS);

    const pollResp = await client.get("/vendas/downloads");
    if (!pollResp.ok) {
      throw new Error(`Failed to poll downloads - HTTP ${pollResp.status}`);
    }

    const pollHtml = await pollResp.text();
    const generatedDownload = findTodayDownload(parseFileTable(pollHtml), todayBrt, options.fileNameIncludes);
    if (generatedDownload) {
      return {
        ...generatedDownload,
        source: "generated",
      };
    }
  }

  throw new Error(`${options.fileNameIncludes} report not generated after ${DOWNLOADS_POLL_MAX_ATTEMPTS} attempts`);
}
