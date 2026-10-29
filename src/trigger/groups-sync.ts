import { logger, task } from "@trigger.dev/sdk";
import { runGroupSync, type GroupSyncPayload } from "../lib/supabase/groups.js";

export const groupsSync = task({
  id: "groups-sync",
  maxDuration: 3600,
  retry: { maxAttempts: 1 },
  queue: { concurrencyLimit: 1 },
  run: async (payload: GroupSyncPayload = {}, { ctx }) =>
    runGroupSync(payload, ctx.run.id, logger),
});
