import { logger, task } from "@trigger.dev/sdk";
import {
  fetchBdProducaoRowsForFidelidadeSync,
  syncBdProducaoFidelidadeFields,
} from "../lib/supabase/daily-sync.js";

interface FidelidadeSyncPayload {
  contracts?: string[];
  dryRun?: boolean;
}

export const fidelidadeSync = task({
  id: "fidelidade-sync",
  maxDuration: 900,
  queue: { concurrencyLimit: 1 },
  run: async (payload: FidelidadeSyncPayload = {}) => {
    if (payload.dryRun) {
      return {
        workflow: "fidelidade-sync",
        mode: "dry-run",
        sideEffects: { supabaseWrites: 0 },
        updatedTrueCount: 0,
        updatedFalseCount: 0,
        fidelidadeSync: { updatedTrueCount: 0, updatedFalseCount: 0 },
      };
    }

    const requestedContracts = [
      ...new Set(
        (payload?.contracts ?? [])
          .map((contract) => String(contract).trim())
          .filter(Boolean),
      ),
    ];

    const candidateRows = await fetchBdProducaoRowsForFidelidadeSync(
      requestedContracts.length > 0 ? { contracts: requestedContracts } : undefined,
    );
    const pendingContracts = candidateRows
      .filter((row) => row.gp_fidelidade === null)
      .map((row) => row.nr_contrato);

    logger.log("Fidelidade sync started", {
      requestedContractsCount: requestedContracts.length,
      candidateCount: candidateRows.length,
      pendingContractsCount: pendingContracts.length,
    });

    const fidelidadeResult = await syncBdProducaoFidelidadeFields(
      requestedContracts.length > 0 ? { contracts: requestedContracts } : undefined,
    );

    logger.log("Fidelidade sync completed", {
      requestedContractsCount: requestedContracts.length,
      candidateCount: candidateRows.length,
      pendingContractsCount: pendingContracts.length,
      fidelidadeResult,
    });

    return {
      workflow: "fidelidade-sync",
      requestedContractsCount: requestedContracts.length,
      candidateCount: candidateRows.length,
      pendingContractsCount: pendingContracts.length,
      fidelidadeSync: fidelidadeResult,
    };
  },
});
