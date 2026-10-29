import {
  createSession,
  type AlpnProtocol,
  type BrowserProfile,
  type CustomEmulationOptions,
  type CustomHttp1Options,
  type CustomHttp2Options,
  type CustomTlsOptions,
  type EmulationOS,
  type Response as WreqResponse,
  type Session,
} from "wreq-js";
import { decodeEntities } from "../parsers.js";

const BASE_URL = "https://www.consorcioservopa.com.br";
const LOGIN_URL = `${BASE_URL}/vendas/login`;
const LOGIN_MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2_000, 5_000];
const REQUEST_MAX_ATTEMPTS = 3;
const WORKING_LOGIN_PROFILES: BrowserProfile[] = [
  "firefox_149", "firefox_147", "firefox_135", "safari_18",
];
const RETRYABLE_HTTP_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525]);

interface HttpClientOptions {
  cpfCnpj: string;
  senha: string;
  browser?: BrowserProfile;
  os?: EmulationOS;
  alpnProtocols?: AlpnProtocol[] | null;
  tlsOptions?: CustomTlsOptions;
  http1Options?: CustomHttp1Options;
  http2Options?: CustomHttp2Options;
  emulationHeaders?: Record<string, string>;
  defaultHeaders?: Record<string, string>;
  proxy?: string;
  timeout?: number;
  insecure?: boolean;
  trustStore?: "combined" | "mozilla" | "defaultPaths";
  captureDiagnostics?: boolean;
  loginMaxAttempts?: number;
}

function extractHiddenInputs(html: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const input of String(html).match(/<input\b[^>]*>/gi) || []) {
    if ((input.match(/\btype=["']([^"']+)["']/i) || [])[1]?.toLowerCase() !== "hidden") continue;
    const name = (input.match(/\bname=["']([^"']+)["']/i) || [])[1];
    if (!name) continue;
    result[decodeEntities(name)] = decodeEntities(
      (input.match(/\bvalue=["']([^"']*)["']/i) || [])[1] ?? ""
    );
  }
  return result;
}

function getHttpStatus(error: unknown): number | null {
  const match = String(error instanceof Error ? error.message : error).match(/HTTP\s+(\d{3})/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function shouldRetryRequest(error: unknown): boolean {
  const status = getHttpStatus(error);
  if (status !== null) return RETRYABLE_HTTP_STATUSES.has(status);

  return /fetch|timeout|timed out|econnreset|eai_again|socket|error sending request|connection.*(?:reset|closed)|unexpected eof/i.test(
    String(error instanceof Error ? error.message : error),
  );
}

export async function requestWithRetries<T extends { status: number }>(
  request: () => Promise<T>,
  method = "GET",
  retrySafe = true,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    let status: number | null = null;
    try {
      const response = await request();
      // A 403 explicitly rejects the request; unlike a lost response, it can be retried for POSTs too.
      const retryable = response.status === 403 ||
        (retrySafe && RETRYABLE_HTTP_STATUSES.has(response.status));
      if (attempt === REQUEST_MAX_ATTEMPTS || !retryable) {
        return response;
      }
      status = response.status;
    } catch (error) {
      status = getHttpStatus(error);
      const retryable = status === 403 || (retrySafe && shouldRetryRequest(error));
      if (attempt === REQUEST_MAX_ATTEMPTS || !retryable) throw error;
    }
    const delayMs = RETRY_DELAYS_MS[attempt - 1]!;
    console.warn(`Servopa request attempt ${attempt} failed; retrying in ${delayMs}ms`, {
      method,
      status,
    });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export function loginProfiles(browser?: BrowserProfile): BrowserProfile[] {
  return browser ? [browser] : [...WORKING_LOGIN_PROFILES];
}

export class HttpClient {
  private session: Session | null = null;
  private options: HttpClientOptions;

  constructor(options: HttpClientOptions) {
    this.options = options;
  }

  async login(): Promise<void> {
    const emulation: CustomEmulationOptions = {
      headers: {
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
        ...(this.options.emulationHeaders ?? {}),
      },
      ...(this.options.http1Options ? { http1Options: this.options.http1Options } : {}),
      ...(this.options.http2Options ? { http2Options: this.options.http2Options } : {}),
    };

    if (this.options.alpnProtocols != null) {
      emulation.tlsOptions = {
        ...(this.options.tlsOptions ?? {}),
        alpnProtocols: this.options.alpnProtocols,
      };
    } else if (this.options.tlsOptions) {
      emulation.tlsOptions = this.options.tlsOptions;
    }

    let lastError: unknown = null;

    const profiles = loginProfiles(this.options.browser);
    const maxAttempts = this.options.loginMaxAttempts ?? (this.options.browser ? LOGIN_MAX_ATTEMPTS : profiles.length);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const browser = profiles[(attempt - 1) % profiles.length];
      try {
        await this.close();
        this.session = await createSession({
          browser,
          os: this.options.os ?? "windows",
          emulation,
          ...(this.options.defaultHeaders ? { defaultHeaders: this.options.defaultHeaders } : {}),
          ...(this.options.proxy ? { proxy: this.options.proxy } : {}),
          ...(this.options.timeout !== undefined ? { timeout: this.options.timeout } : {}),
          ...(this.options.insecure !== undefined ? { insecure: this.options.insecure } : {}),
          ...(this.options.trustStore ? { trustStore: this.options.trustStore } : {}),
          ...(this.options.captureDiagnostics !== undefined
            ? { captureDiagnostics: this.options.captureDiagnostics }
            : {}),
        });

        const initResp = await this.session.fetch(LOGIN_URL);
        if (!initResp.ok) {
          throw new Error(`Login init failed — HTTP ${initResp.status}`);
        }

        const initHtml = await initResp.text();
        const loginForm = {
          ...extractHiddenInputs(initHtml),
          cpf_cnpj: this.options.cpfCnpj,
          senha: this.options.senha,
          tipo: "1",
          btn_representante: "",
        };

        const loginResp = await this.session.fetch(LOGIN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Upgrade-Insecure-Requests": "1",
          },
          body: new URLSearchParams(loginForm).toString(),
        });

        if (!loginResp.ok) {
          throw new Error(`Login POST failed — HTTP ${loginResp.status}`);
        }

        if (!loginResp.url.includes("/dashboard")) {
          throw new Error("Login failed — not redirected to dashboard");
        }

        return;
      } catch (error) {
        lastError = error;
        await this.close().catch(() => undefined);

        if (attempt === maxAttempts || !shouldRetryRequest(error)) {
          throw error;
        }

        const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1)!;
        console.warn(`Servopa login attempt ${attempt} failed; retrying in ${delayMs}ms`, {
          status: getHttpStatus(error),
          browser,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Servopa login failed");
  }

  private async request(
    path: string,
    options?: Parameters<Session["fetch"]>[1],
    retrySafe = true,
  ): Promise<WreqResponse> {
    if (!this.session) throw new Error("Not logged in");
    // Reuse the session so retries preserve the selected contract.
    return requestWithRetries(
      () => this.session!.fetch(`${BASE_URL}${path}`, options),
      options?.method ?? "GET",
      retrySafe,
    );
  }

  async get(path: string): Promise<WreqResponse> {
    return this.request(path);
  }

  async getBuffer(path: string): Promise<Buffer> {
    const resp = await this.request(path, {
      headers: {
        Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
      },
    });
    if (!resp.ok) {
      throw new Error(`Failed to fetch ${path} — HTTP ${resp.status}`);
    }
    const arrayBuffer = await resp.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async post(
    path: string,
    body?: string | URLSearchParams,
    options?: { retrySafe?: boolean },
  ): Promise<WreqResponse> {
    return this.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body?.toString(),
    }, options?.retrySafe === true);
  }

  async postJson(path: string, body: unknown): Promise<WreqResponse> {
    return this.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify(body),
    }, false);
  }

  async postRaw(
    path: string,
    body: string,
    headers?: Record<string, string>,
  ): Promise<WreqResponse> {
    return this.request(path, {
      method: "POST",
      headers: {
        ...(headers ?? {}),
      },
      body,
    }, false);
  }

  getPhpSessId(): string | null {
    if (!this.session) throw new Error("Not logged in");
    const cookies = this.session.getCookies(BASE_URL);
    const value = cookies.PHPSESSID;

    if (Array.isArray(value)) {
      return value[0] ?? null;
    }

    return value ?? null;
  }

  getCookieNames(): string[] {
    if (!this.session) throw new Error("Not logged in");
    return this.session
      .getAllCookies()
      .map((cookie) => cookie.name)
      .filter((name, index, names) => names.indexOf(name) === index)
      .sort();
  }

  async logout(): Promise<void> {
    if (!this.session) return;
    const resp = await this.request("/vendas/logout", {
      redirect: "manual",
    }, false);
    if (resp.status !== 302) {
      throw new Error(`Logout failed — expected 302, got ${resp.status}`);
    }
  }

  async close(): Promise<void> {
    if (this.session) {
      await this.session.close();
      this.session = null;
    }
  }
}
