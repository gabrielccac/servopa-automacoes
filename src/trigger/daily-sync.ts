import { logger, task } from "@trigger.dev/sdk";
import { getConfig } from "../lib/config.js";
import { fetchOrGenerateDownload, getTodayBrtText, parseFileTable } from "../lib/servopa/downloads.js";
import { HttpClient } from "../lib/servopa/http-client.js";
import { parseAsOfDate } from "../lib/reminders/shared.js";
import {
  syncBdClientesCsv,
  syncBdProducaoCsv,
  syncDisponivelParaVenderCsv,
  syncInadimplentesPdf,
  syncResultadoUltimasAssembleiasCsv,
} from "../lib/supabase/daily-sync.js";
import { getTodayIsoDateInSaoPaulo } from "../lib/supabase/customers.js";
import { sendExecutionSummary } from "../lib/whatsapp/zapi.js";
import { fidelidadeSync } from "./fidelidade-sync.js";

export const dailySync = task({
  id: "daily-sync",
  maxDuration: 900,
  queue: { concurrencyLimit: 1 },
  run: async (payload: unknown) => {
    const input =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { dryRun?: boolean; asOfDate?: unknown; sendSummary?: boolean })
        : null;
    const dryRun = input?.dryRun ?? false;
    const sendSummary = input?.sendSummary !== false;
    const asOfDate = parseAsOfDate(input?.asOfDate);
    const syncDate = asOfDate ?? getTodayIsoDateInSaoPaulo();

    if (dryRun) {
      return {
        workflow: "daily-sync",
        mode: "dry-run",
        asOfDate,
        sideEffects: {
          supabaseWrites: 0,
          reportGeneration: 0,
        },
      };
    }

    const client = new HttpClient(getConfig().servopa);

    try {
      logger.log("Logging in to Servopa for daily sync");
      await client.login();
      logger.log("Logged in to Servopa");

      logger.log("Fetching inadimplentes report list");
      const inadimplentesResp = await client.get("/vendas/relatorios-inadimplentes");
      if (!inadimplentesResp.ok) {
        throw new Error(`Failed to fetch inadimplentes - HTTP ${inadimplentesResp.status}`);
      }

      const inadimplentesHtml = await inadimplentesResp.text();
      const inadimplentesFiles = parseFileTable(inadimplentesHtml);
      if (inadimplentesFiles.length === 0) {
        logger.log("No inadimplentes files found");
        return { files: [] };
      }

      logger.log("Found inadimplentes files", {
        count: inadimplentesFiles.length,
        latest: inadimplentesFiles[0].fileName,
      });

      logger.log("Fetching diversos file list");
      const diversosResp = await client.get("/vendas/diversos");
      if (!diversosResp.ok) {
        throw new Error(`Failed to fetch diversos - HTTP ${diversosResp.status}`);
      }

      const diversosHtml = await diversosResp.text();
      const diversosFiles = parseFileTable(diversosHtml);
      logger.log("Found diversos files", { count: diversosFiles.length });

      const assembleiasFile = diversosFiles.find((file) =>
        file.fileName.toUpperCase().includes("RESULTADO_ULTIMAS_ASSEMBLEIAS"),
      );
      const disponivelParaVenderFile = diversosFiles.find((file) =>
        file.fileName.toUpperCase().includes("DISPONIVEL_PARA_VENDER"),
      );

      logger.log("Fetching or generating BD_PRODUCAO");
      const productionDownload = await fetchOrGenerateDownload(client, {
        fileNameIncludes: "BD_PRODUCAO",
        triggerPayload: {
          dt_ini: "01/01/2025",
          dt_fin: getTodayBrtText(),
          grupo: "",
          ano: "",
          categoria: "PRO",
        },
      });
      logger.log("BD_PRODUCAO ready", { file: productionDownload.fileName });

      logger.log("Fetching or generating BD_CLIENTES");
      const clientesDownload = await fetchOrGenerateDownload(client, {
        fileNameIncludes: "BD_CLIENTES",
        triggerPayload: {
          dt_ini: "",
          dt_fin: "",
          grupo: "",
          ano: "",
          categoria: "CLI",
        },
      });
      logger.log("BD_CLIENTES ready", { file: clientesDownload.fileName });

      const latestFile = inadimplentesFiles[0];
      const files = [latestFile, ...diversosFiles, productionDownload, clientesDownload];

      logger.log("Starting file sync", {
        inadimplentes: latestFile.fileName,
        bdProducao: productionDownload.fileName,
        bdClientes: clientesDownload.fileName,
        assembleias: assembleiasFile?.fileName ?? "not found",
        disponivelParaVender: disponivelParaVenderFile?.fileName ?? "not found",
      });

      logger.log("Downloading BD_PRODUCAO CSV");
      const productionUrl = new URL(productionDownload.fileUrl);
      const productionCsvBuffer = await client.getBuffer(
        productionUrl.pathname + productionUrl.search,
      );
      logger.log("Syncing bd_producao", {
        file: productionDownload.fileName,
        sizeKb: Math.round(productionCsvBuffer.length / 1024),
      });
      const bdProducaoSync = await syncBdProducaoCsv(productionCsvBuffer.toString("utf-8"));
      logger.log("Synced bd_producao", { rowCount: bdProducaoSync.rowCount });

      logger.log("Downloading BD_CLIENTES CSV");
      const clientesUrl = new URL(clientesDownload.fileUrl);
      const clientesCsvBuffer = await client.getBuffer(
        clientesUrl.pathname + clientesUrl.search,
      );
      logger.log("Syncing bd_clientes", {
        file: clientesDownload.fileName,
        sizeKb: Math.round(clientesCsvBuffer.length / 1024),
      });
      const bdClientesSync = await syncBdClientesCsv(
        clientesCsvBuffer.toString("utf-8"),
        syncDate,
      );
      logger.log("Synced bd_clientes", { rowCount: bdClientesSync.rowCount });

      let assembleiasSync: { rowCount: number } | null = null;
      if (assembleiasFile) {
        logger.log("Downloading RESULTADO_ULTIMAS_ASSEMBLEIAS CSV");
        const assembleiasUrl = new URL(assembleiasFile.fileUrl);
        const assembleiasCsvBuffer = await client.getBuffer(
          assembleiasUrl.pathname + assembleiasUrl.search,
        );
        logger.log("Syncing resultado_ultimas_assembleias", {
          file: assembleiasFile.fileName,
          sizeKb: Math.round(assembleiasCsvBuffer.length / 1024),
        });
        assembleiasSync = await syncResultadoUltimasAssembleiasCsv(
          assembleiasCsvBuffer.toString("utf-8"),
        );
        logger.log("Synced resultado_ultimas_assembleias", {
          rowCount: assembleiasSync.rowCount,
        });
      } else {
        logger.log("Skipping resultado_ultimas_assembleias - file not found");
      }

      let disponivelParaVenderSync: { rowCount: number } | null = null;
      if (disponivelParaVenderFile) {
        logger.log("Downloading DISPONIVEL_PARA_VENDER CSV");
        const disponivelUrl = new URL(disponivelParaVenderFile.fileUrl);
        const disponivelCsvBuffer = await client.getBuffer(
          disponivelUrl.pathname + disponivelUrl.search,
        );
        logger.log("Syncing disponivel_para_vender", {
          file: disponivelParaVenderFile.fileName,
          sizeKb: Math.round(disponivelCsvBuffer.length / 1024),
        });
        disponivelParaVenderSync = await syncDisponivelParaVenderCsv(
          disponivelCsvBuffer.toString("utf-8"),
          syncDate,
        );
        logger.log("Synced disponivel_para_vender", {
          rowCount: disponivelParaVenderSync.rowCount,
        });
      } else {
        logger.log("Skipping disponivel_para_vender - file not found");
      }

      logger.log("Downloading inadimplentes PDF");
      const inadimplentesUrl = new URL(latestFile.fileUrl);
      const inadimplentesPdfBuffer = await client.getBuffer(
        inadimplentesUrl.pathname + inadimplentesUrl.search,
      );
      logger.log("Syncing inadimplentes", {
        file: latestFile.fileName,
        sizeKb: Math.round(inadimplentesPdfBuffer.length / 1024),
      });
      const inadimplentesSync = await syncInadimplentesPdf(
        inadimplentesPdfBuffer,
        syncDate,
      );
      logger.log("Synced inadimplentes", {
        rowCount: inadimplentesSync.rowCount,
        inserted: inadimplentesSync.insertedCount,
        updated: inadimplentesSync.updatedCount,
        closed: inadimplentesSync.closedCount,
      });

      await client.logout();
      logger.log("Logged out from Servopa");

      const fidelidadeSyncResult = assembleiasSync
        ? await fidelidadeSync
            .triggerAndWait({
              contracts: bdProducaoSync.contracts,
            })
            .unwrap()
        : null;

      if (assembleiasSync) {
        logger.log("Fidelidade sync completed", fidelidadeSyncResult ?? undefined);
      } else {
        logger.log("Skipping fidelidade-sync - assembleias file not found");
      }

      if (sendSummary) {
        await sendExecutionSummary(
        [
          "Extração diária concluída.",
          `bd_producao: ${bdProducaoSync.rowCount} linhas.`,
          `bd_clientes: ${bdClientesSync.rowCount} linhas.`,
          assembleiasSync
            ? `resultado_ultimas_assembleias: ${assembleiasSync.rowCount} linhas.`
            : "resultado_ultimas_assembleias: arquivo não encontrado.",
          disponivelParaVenderSync
            ? `disponivel_para_vender: ${disponivelParaVenderSync.rowCount} linhas.`
            : "disponivel_para_vender: arquivo não encontrado.",
          `inadimplentes: ${inadimplentesSync.rowCount} linhas (${inadimplentesSync.insertedCount} novas, ${inadimplentesSync.updatedCount} atualizadas, ${inadimplentesSync.closedCount} encerradas).`,
          fidelidadeSyncResult
            ? `fidelidade: ${fidelidadeSyncResult.fidelidadeSync.updatedTrueCount} true, ${fidelidadeSyncResult.fidelidadeSync.updatedFalseCount} false.`
            : "fidelidade: não executado.",
        ].join("\n"),
        );
      }

      return {
        files,
        sync: {
          bdProducao: {
            fileName: productionDownload.fileName,
            rowCount: bdProducaoSync.rowCount,
          },
          bdClientes: {
            fileName: clientesDownload.fileName,
            rowCount: bdClientesSync.rowCount,
          },
          resultadoUltimasAssembleias: assembleiasSync
            ? {
                fileName: assembleiasFile?.fileName ?? null,
                rowCount: assembleiasSync.rowCount,
              }
            : null,
          disponivelParaVender: disponivelParaVenderSync
            ? {
                fileName: disponivelParaVenderFile?.fileName ?? null,
                rowCount: disponivelParaVenderSync.rowCount,
              }
            : null,
          inadimplentes: {
            fileName: latestFile.fileName,
            synced: true,
            rowCount: inadimplentesSync.rowCount,
            insertedCount: inadimplentesSync.insertedCount,
            updatedCount: inadimplentesSync.updatedCount,
            closedCount: inadimplentesSync.closedCount,
          },
          fidelidade: fidelidadeSyncResult,
        },
      };
    } finally {
      await client.close();
    }
  },
});
