import { logger, task, wait } from "@trigger.dev/sdk";
import {
  getOperatingSystems,
  getProfiles,
  type AlpnProtocol,
  type BrowserProfile,
  type CustomHttp1Options,
  type CustomHttp2Options,
  type CustomTlsOptions,
  type EmulationOS,
} from "wreq-js";
import { getConfig } from "../lib/config.js";
import { HttpClient } from "../lib/servopa/http-client.js";
import { parseFileTable } from "../lib/servopa/downloads.js";

const DEFAULT_PROFILES: BrowserProfile[] = [
  "firefox_149",
  "firefox_148",
  "firefox_135",
  "chrome_142",
  "chrome_131",
  "edge_140",
  "safari_18",
];

const HTTP_VERSIONS = ["profile", "HTTP1", "HTTP2", "HTTP3"] as const;
type HttpVersion = (typeof HTTP_VERSIONS)[number];

type DiagnosticInput = {
  profiles?: unknown;
  os?: unknown;
  probeDownload?: unknown;
  cases?: unknown;
  delaySeconds?: unknown;
  repetitions?: unknown;
};

type DiagnosticCaseInput = {
  name?: unknown;
  browser?: unknown;
  os?: unknown;
  httpVersion?: unknown;
  userAgent?: unknown;
  acceptLanguage?: unknown;
  headers?: unknown;
  timeoutMs?: unknown;
  tlsOptions?: unknown;
  http1Options?: unknown;
  http2Options?: unknown;
  probeDownload?: unknown;
};

type DiagnosticCase = {
  name: string;
  browser: BrowserProfile;
  os: EmulationOS;
  httpVersion: HttpVersion;
  userAgent: string | null;
  acceptLanguage: string | null;
  headers: Record<string, string>;
  timeoutMs: number | null;
  tlsOptions: CustomTlsOptions | undefined;
  http1Options: CustomHttp1Options | undefined;
  http2Options: CustomHttp2Options | undefined;
  probeDownload: boolean;
};

type DiagnosticResult = {
  caseIndex: number;
  attempt: number;
  repetitionsRequested: number;
  name: string;
  browser: BrowserProfile;
  os: EmulationOS;
  httpVersion: HttpVersion;
  userAgentProvided: boolean;
  acceptLanguageProvided: boolean;
  customHeaderNames: string[];
  timeoutMs: number | null;
  tlsOptionKeys: string[];
  http1OptionKeys: string[];
  http2OptionKeys: string[];
  credentialSource: "env";
  loginOk: boolean;
  loginError: string | null;
  loginStatus: number | null;
  cookieNames: string[];
  downloadsPageStatus: number | null;
  downloadProbe: Record<string, unknown> | null;
};

function asInput(payload: unknown): DiagnosticInput {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as DiagnosticInput)
    : {};
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, item]) => typeof item === "string")
      .map(([key, item]) => [key, item as string]),
  );
}

function asPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function asHttpVersion(value: unknown): HttpVersion {
  return HTTP_VERSIONS.includes(value as HttpVersion) ? (value as HttpVersion) : "HTTP2";
}

function resolveAlpnProtocols(httpVersion: HttpVersion): AlpnProtocol[] | null {
  if (httpVersion === "profile") return null;
  return [httpVersion as AlpnProtocol];
}

function safeOptionKeys(value: unknown): string[] {
  return Object.keys(asRecord(value) ?? {}).sort();
}

function buildCase(
  input: DiagnosticCaseInput,
  index: number,
  defaults: { os: EmulationOS; probeDownload: boolean },
  availableProfiles: Set<string>,
  availableOperatingSystems: Set<string>,
): { value: DiagnosticCase | null; error: string | null } {
  const browser = String(input.browser ?? "");
  const os = String(input.os ?? defaults.os);
  if (!availableProfiles.has(browser)) {
    return { value: null, error: `Unsupported browser profile: ${browser || "missing"}` };
  }
  if (!availableOperatingSystems.has(os)) {
    return { value: null, error: `Unsupported emulation OS: ${os}` };
  }

  const timeoutMs = input.timeoutMs === undefined ? null : asPositiveInteger(input.timeoutMs);
  if (input.timeoutMs !== undefined && timeoutMs === null) {
    return { value: null, error: "timeoutMs must be a positive integer" };
  }

  const httpVersion = asHttpVersion(input.httpVersion);
  return {
    value: {
      name: String(input.name ?? `${browser}-${httpVersion}-${index + 1}`),
      browser: browser as BrowserProfile,
      os: os as EmulationOS,
      httpVersion,
      userAgent: typeof input.userAgent === "string" ? input.userAgent : null,
      acceptLanguage: typeof input.acceptLanguage === "string" ? input.acceptLanguage : null,
      headers: asStringMap(input.headers),
      timeoutMs,
      tlsOptions: (asRecord(input.tlsOptions) ?? undefined) as CustomTlsOptions | undefined,
      http1Options: (asRecord(input.http1Options) ?? undefined) as CustomHttp1Options | undefined,
      http2Options: (asRecord(input.http2Options) ?? undefined) as CustomHttp2Options | undefined,
      probeDownload:
        typeof input.probeDownload === "boolean"
          ? input.probeDownload
          : defaults.probeDownload,
    },
    error: null,
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\?[^\s]+/g, "?<redacted>");
}

function httpStatus(error: unknown): number | null {
  const match = errorMessage(error).match(/HTTP\s+(\d{3})/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function resultPassed(result: DiagnosticResult): boolean {
  return (
    result.loginOk &&
    result.downloadsPageStatus === 200 &&
    (result.downloadProbe === null || result.downloadProbe.ok === true)
  );
}

export const diagnoseServopaAccess = task({
  id: "diagnose-servopa-access",
  maxDuration: 600,
  retry: { maxAttempts: 1 },
  run: async (payload: unknown) => {
    const input = asInput(payload);
    const availableProfiles = new Set<string>(getProfiles());
    const availableOperatingSystems = new Set<string>(getOperatingSystems());
    const requestedOs = typeof input.os === "string" ? input.os : "windows";
    if (!availableOperatingSystems.has(requestedOs)) {
      throw new Error(`Unsupported emulation OS: ${requestedOs}`);
    }

    const os = requestedOs as EmulationOS;
    const probeDownload = input.probeDownload === true;
    const requestedProfiles = Array.isArray(input.cases)
      ? []
      : Array.isArray(input.profiles)
        ? input.profiles.map(String)
        : DEFAULT_PROFILES;
    const invalidProfiles = requestedProfiles.filter((profile) => !availableProfiles.has(profile));
    const invalidCases: Array<{ name: string; error: string }> = [];
    const cases: DiagnosticCase[] = [];

    if (Array.isArray(input.cases)) {
      for (const [index, rawCase] of input.cases.entries()) {
        const built = buildCase(
          (asRecord(rawCase) ?? {}) as DiagnosticCaseInput,
          index,
          { os, probeDownload },
          availableProfiles,
          availableOperatingSystems,
        );
        if (built.value) {
          cases.push(built.value);
        } else {
          invalidCases.push({ name: `case-${index + 1}`, error: built.error ?? "Invalid case" });
        }
      }
    } else {
      for (const [index, browser] of requestedProfiles.entries()) {
        const built = buildCase(
          { browser, os, httpVersion: "HTTP2" },
          index,
          { os, probeDownload },
          availableProfiles,
          availableOperatingSystems,
        );
        if (built.value) cases.push(built.value);
      }
    }

    const delaySeconds =
      typeof input.delaySeconds === "number" &&
      Number.isFinite(input.delaySeconds) &&
      input.delaySeconds >= 0 &&
      input.delaySeconds <= 120
        ? input.delaySeconds
        : 0;
    const repetitions =
      typeof input.repetitions === "number" &&
      Number.isInteger(input.repetitions) &&
      input.repetitions >= 1 &&
      input.repetitions <= 10
        ? input.repetitions
        : 1;
    const results: DiagnosticResult[] = [];

    for (const [caseIndex, diagnosticCase] of cases.entries()) {
      for (let attempt = 1; attempt <= repetitions; attempt += 1) {
        const index = caseIndex * repetitions + attempt - 1;
        if (index > 0 && delaySeconds > 0) {
        await wait.for({ seconds: delaySeconds });
        }

      const client = new HttpClient({
        ...getConfig().servopa,
        browser: diagnosticCase.browser,
        os: diagnosticCase.os,
        alpnProtocols: resolveAlpnProtocols(diagnosticCase.httpVersion),
        tlsOptions: diagnosticCase.tlsOptions,
        http1Options: diagnosticCase.http1Options,
        http2Options: diagnosticCase.http2Options,
        emulationHeaders: {
          ...(diagnosticCase.acceptLanguage
            ? { "Accept-Language": diagnosticCase.acceptLanguage }
            : {}),
          ...(diagnosticCase.userAgent ? { "User-Agent": diagnosticCase.userAgent } : {}),
        },
        defaultHeaders: diagnosticCase.headers,
        timeout: diagnosticCase.timeoutMs ?? undefined,
      });
      const result: DiagnosticResult = {
        caseIndex,
        attempt,
        repetitionsRequested: repetitions,
        name: diagnosticCase.name,
        browser: diagnosticCase.browser,
        os: diagnosticCase.os,
        httpVersion: diagnosticCase.httpVersion,
        userAgentProvided: Boolean(diagnosticCase.userAgent),
        acceptLanguageProvided: Boolean(diagnosticCase.acceptLanguage),
        customHeaderNames: Object.keys(diagnosticCase.headers).sort(),
        timeoutMs: diagnosticCase.timeoutMs,
        tlsOptionKeys: safeOptionKeys(diagnosticCase.tlsOptions),
        http1OptionKeys: safeOptionKeys(diagnosticCase.http1Options),
        http2OptionKeys: safeOptionKeys(diagnosticCase.http2Options),
        credentialSource: "env",
        loginOk: false,
        loginError: null,
        loginStatus: null,
        cookieNames: [],
        downloadsPageStatus: null,
        downloadProbe: null,
      };

      try {
        await client.login();
        result.loginOk = true;
        result.cookieNames = client.getCookieNames();
        const downloadsResp = await client.get("/vendas/downloads");
        result.downloadsPageStatus = downloadsResp.status;

        if (diagnosticCase.probeDownload && downloadsResp.ok) {
          const file = parseFileTable(await downloadsResp.text())[0];
          if (!file) {
            result.downloadProbe = { ok: false, reason: "no_file_listed" };
          } else {
            const fileUrl = new URL(file.fileUrl);
            try {
              const buffer = await client.getBuffer(fileUrl.pathname + fileUrl.search);
              result.downloadProbe = {
                ok: true,
                status: 200,
                fileName: file.fileName,
                sizeBytes: buffer.length,
              };
            } catch (error) {
              result.downloadProbe = {
                ok: false,
                status: httpStatus(error),
                fileName: file.fileName,
                error: errorMessage(error),
              };
            }
          }
        }
      } catch (error) {
        try {
          result.cookieNames = client.getCookieNames();
        } catch {
          // The session may not have been created if initialization failed.
        }
        result.loginError = errorMessage(error);
        result.loginStatus = httpStatus(error);
      } finally {
        await client.close().catch(() => undefined);
      }

      logger.log("Servopa access diagnostic", result);
      results.push(result);
      }
    }

    const consistency = cases.map((diagnosticCase, caseIndex) => {
      const attempts = results.filter((result) => result.caseIndex === caseIndex);
      const passedAttempts = attempts.filter(resultPassed).length;
      return {
        caseIndex,
        name: diagnosticCase.name,
        browser: diagnosticCase.browser,
        os: diagnosticCase.os,
        httpVersion: diagnosticCase.httpVersion,
        attemptsRequested: repetitions,
        attemptsCompleted: attempts.length,
        passedAttempts,
        failedAttempts: attempts.length - passedAttempts,
        successRate: attempts.length === 0 ? 0 : passedAttempts / attempts.length,
        consistent: attempts.length === repetitions && passedAttempts === repetitions,
      };
    });

    return {
      requestedProfiles,
      invalidProfiles,
      requestedCaseCount: Array.isArray(input.cases) ? input.cases.length : cases.length,
      invalidCases,
      delaySeconds,
      repetitions,
      os,
      probeDownload: cases.some((diagnosticCase) => diagnosticCase.probeDownload),
      allCasesConsistent: cases.length > 0 && consistency.every((item) => item.consistent),
      credentialSource: "SERVOPA_CPF_CNPJ + SERVOPA_SENHA env vars",
      consistency,
      results,
    };
  },
});
