import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

export async function probeDatabase(config, fetcher = fetch) {
  if (!config.url || !config.key) return { status: "missing_credentials", tables: [] };
  let base;
  try { base = new URL(config.url); } catch { return { status: "invalid_url", tables: [] }; }
  if (base.protocol !== "https:" || base.hostname !== `${config.projectRef}.supabase.co` || base.username || base.password) {
    return { status: "unexpected_project", tables: [] };
  }
  const tables = [];
  for (const table of config.tables) {
    const url = new URL(`/rest/v1/${table}`, base);
    url.searchParams.set("select", "*");
    url.searchParams.set("limit", "0");
    try {
      const response = await fetcher(url, {
        method: "HEAD",
        headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
        signal: AbortSignal.timeout(15_000),
      });
      tables.push({ table, http_status: response.status, readable: response.ok });
    } catch {
      tables.push({ table, readable: false, error: "connection_failed" });
    }
  }
  return { status: tables.every((table) => table.readable) ? "ok" : "review_required", tables };
}

async function main() {
  const root = process.cwd();
  const envPath = path.join(root, ".env");
  const env = { ...(fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, "utf8")) : {}), ...process.env };
  const needed = ["SERVOPA_CPF_CNPJ", "SERVOPA_SENHA", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
    "ZAPI_INSTANCE_ID", "ZAPI_INSTANCE_TOKEN", "ZAPI_CLIENT_TOKEN"];
  const sdkPath = path.join(root, "node_modules/@trigger.dev/sdk/package.json");
  const triggerPath = path.join(root, "trigger.config.ts");
  const report = {
    checkout: root,
    node: process.version,
    env_file_exists: fs.existsSync(envPath),
    missing_runtime_variables: needed.filter((name) => !env[name]?.trim()),
    sdk_version: fs.existsSync(sdkPath) ? JSON.parse(fs.readFileSync(sdkPath, "utf8")).version : null,
    trigger_project: fs.existsSync(triggerPath)
      ? /project:\s*["']([^"']+)["']/.exec(fs.readFileSync(triggerPath, "utf8"))?.[1] ?? null : null,
    primary: await probeDatabase({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY,
      projectRef: "umvldqzzliqmgkvoedyd", tables: ["bd_producao", "bd_clientes", "lances", "lances_submetidos",
        "reminder_logs", "inadimplentes", "resultado_ultimas_assembleias", "disponivel_para_vender", "grupos", "grupos_sincronizacoes"] }),
    secondary: env.ALT_SUPABASE_URL || env.ALT_SUPABASE_SERVICE_ROLE_KEY
      ? await probeDatabase({ url: env.ALT_SUPABASE_URL, key: env.ALT_SUPABASE_SERVICE_ROLE_KEY,
        projectRef: "kwimrjvgingabctgegvl", tables: ["clientes", "assinados_investimento", "consultoria", "mentoria", "contratos_servicos", "contratos_Titulo-Privado"] })
      : { status: "not_configured", tables: [] },
    mcp_connection: "verify_with_client_tool",
    sql_access: "not_tested",
    effects: { database_writes: 0, customer_rows_read: 0, messages: 0, bids: 0 },
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.missing_runtime_variables.length || report.sdk_version !== "4.5.16" ||
    report.trigger_project !== "proj_wmgnkaivkyvudwfshcad" || report.primary.status !== "ok" ||
    !["ok", "not_configured"].includes(report.secondary.status)) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    console.error("Setup verification failed. Check the local .env syntax and project files; no secrets are included in this error.");
    process.exitCode = 1;
  });
}
