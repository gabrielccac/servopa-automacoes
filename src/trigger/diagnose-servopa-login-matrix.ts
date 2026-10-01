import { task } from "@trigger.dev/sdk";
import { python } from "@trigger.dev/python";
import { type BrowserProfile, type EmulationOS } from "wreq-js";
import { HttpClient } from "../lib/servopa/http-client.js";

type Result = {
  client: string;
  profile: string;
  httpVersion: string;
  repetition: number;
  variant: string;
  loginInitStatus: number | null;
  loginPostStatus: number | null;
  redirectedToDashboard: boolean;
  downloadsStatus: number | null;
  error: string | null;
};

const PROFILES: BrowserProfile[] = [
  "firefox_135", "firefox_147", "firefox_149",
  "chrome_131", "chrome_142", "chrome_145", "edge_101", "safari_18",
];
const VERSIONS = ["profile", "HTTP1", "HTTP2"] as const;
const JS_CASES: Array<{
  profile: BrowserProfile;
  httpVersion: (typeof VERSIONS)[number];
  variant: string;
  os: EmulationOS;
  emulationHeaders?: Record<string, string>;
  defaultHeaders?: Record<string, string>;
}> = [
  ...PROFILES.flatMap((profile) => VERSIONS.map((httpVersion) => ({
    profile, httpVersion, variant: "baseline", os: "windows" as const,
  }))),
  { profile: "firefox_149", httpVersion: "profile", variant: "linux", os: "linux" },
  { profile: "chrome_145", httpVersion: "profile", variant: "macos", os: "macos" },
  { profile: "safari_18", httpVersion: "profile", variant: "macos", os: "macos" },
  { profile: "firefox_149", httpVersion: "profile", variant: "en-US", os: "windows",
    emulationHeaders: { "Accept-Language": "en-US,en;q=0.9" } },
  { profile: "chrome_145", httpVersion: "profile", variant: "en-US", os: "windows",
    emulationHeaders: { "Accept-Language": "en-US,en;q=0.9" } },
  { profile: "firefox_149", httpVersion: "profile", variant: "navigation-headers", os: "windows",
    defaultHeaders: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Upgrade-Insecure-Requests": "1" } },
  { profile: "chrome_145", httpVersion: "profile", variant: "navigation-headers", os: "windows",
    defaultHeaders: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Upgrade-Insecure-Requests": "1" } },
];

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Never return response bodies, URLs, credentials, or cookies from a diagnostic run.
  const status = message.match(/HTTP\s+(\d{3})/i);
  return status ? `HTTP ${status[1]}` : error instanceof Error ? error.name : "RequestError";
}

export const diagnoseServopaLoginMatrix = task({
  id: "diagnose-servopa-login-matrix",
  maxDuration: 1800,
  retry: { maxAttempts: 1 },
  run: async (payload: { repetitions?: number; batch?: "broad" | "shortlist" | "production-client" } = {}) => {
    const repetitions = Number.isInteger(payload.repetitions) && payload.repetitions! >= 1 && payload.repetitions! <= 5
      ? payload.repetitions!
      : 3;
    const cpfCnpj = process.env.SERVOPA_CPF_CNPJ;
    const senha = process.env.SERVOPA_SENHA;
    if (!cpfCnpj || !senha) throw new Error("Missing Servopa credentials in production environment");

    const results: Result[] = [];
    const batch = payload.batch === "shortlist" || payload.batch === "production-client"
      ? payload.batch : "broad";
    const jsCases = batch === "production-client"
      ? JS_CASES.filter((item) => item.profile === "firefox_149" && item.variant === "baseline" && item.httpVersion === "profile")
      : batch === "shortlist"
      ? JS_CASES.filter((item) => item.variant === "baseline" && item.httpVersion === "profile" &&
          ["firefox_135", "firefox_147", "firefox_149", "safari_18"].includes(item.profile))
      : JS_CASES;
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const diagnosticCase of jsCases) {
          const { profile, httpVersion, variant, os, emulationHeaders, defaultHeaders } = diagnosticCase;
          const result: Result = {
            client: "wreq-js", profile: batch === "production-client" ? "auto-fallback" : profile,
            httpVersion, repetition, variant,
            loginInitStatus: null, loginPostStatus: null,
            redirectedToDashboard: false, downloadsStatus: null, error: null,
          };
          const client = new HttpClient(batch === "production-client" ? { cpfCnpj, senha } : {
            cpfCnpj, senha, browser: profile, os, emulationHeaders, defaultHeaders,
            alpnProtocols: httpVersion === "profile" ? null : [httpVersion], loginMaxAttempts: 1,
          });
          try {
            await client.login();
            result.loginInitStatus = 200;
            result.loginPostStatus = 200;
            result.redirectedToDashboard = true;
            result.downloadsStatus = (await client.get("/vendas/downloads")).status;
          } catch (error) {
            result.error = safeError(error);
            const status = Number(result.error.match(/^HTTP (\d{3})$/)?.[1]);
            const message = error instanceof Error ? error.message : "";
            if (status && message.startsWith("Login init failed")) result.loginInitStatus = status;
            if (status && message.startsWith("Login POST failed")) result.loginPostStatus = status;
          } finally {
            await client.close().catch(() => undefined);
          }
          results.push(result);
      }
    }

    if (batch === "broad") {
      const pythonResult = await python.runScript("./python/diagnose_login_matrix.py", [String(repetitions)]);
      if (pythonResult.exitCode !== 0) throw new Error("Python diagnostic process failed");
      results.push(...JSON.parse(pythonResult.stdout) as Result[]);
    }
    const grouped = new Map<string, Result[]>();
    for (const result of results) {
      const key = `${result.client}/${result.profile}/${result.httpVersion}/${result.variant ?? "baseline"}`;
      grouped.set(key, [...(grouped.get(key) ?? []), result]);
    }
    const summary = [...grouped.values()].map((rows) => ({
      client: rows[0].client,
      profile: rows[0].profile,
      httpVersion: rows[0].httpVersion,
      variant: rows[0].variant ?? "baseline",
      passed: rows.filter((r) => r.redirectedToDashboard && r.downloadsStatus === 200).length,
      attempted: rows.length,
    }));
    return { batch, repetitions, summary, results };
  },
});
