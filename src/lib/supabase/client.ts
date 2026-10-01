import { getConfig } from "../config.js";

export function getSupabaseBaseUrl(): string {
  return getConfig().supabase.url;
}

export function getSupabaseHeaders(): Record<string, string> {
  const apiKey = getConfig().supabase.serviceRoleKey;

  return {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

export function quoteCsvValue(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export async function supabaseRestGet(
  pathWithQuery: string,
  options?: {
    headers?: Record<string, string>;
  },
): Promise<Response> {
  const url = `${getSupabaseBaseUrl()}${pathWithQuery}`;
  return fetch(url, {
    method: "GET",
    headers: {
      ...getSupabaseHeaders(),
      ...(options?.headers ?? {}),
    },
  });
}

export async function supabaseRestGetAll<T>(
  pathWithQuery: string,
  options?: {
    pageSize?: number;
  },
): Promise<T[]> {
  const pageSize = options?.pageSize ?? 1000;
  const rows: T[] = [];
  let from = 0;

  while (true) {
    const response = await supabaseRestGet(pathWithQuery, {
      headers: {
        Range: `${from}-${from + pageSize - 1}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch paginated Supabase rows - HTTP ${response.status}`);
    }

    const pageRows = (await response.json()) as T[];
    rows.push(...pageRows);

    if (pageRows.length < pageSize) {
      break;
    }

    from += pageSize;
  }

  return rows;
}

export async function supabaseRestPatch(
  pathWithQuery: string,
  body: unknown,
  options?: {
    headers?: Record<string, string>;
  },): Promise<Response> {
  const url = `${getSupabaseBaseUrl()}${pathWithQuery}`;
  return fetch(url, {
    method: "PATCH",
    headers: {
      ...getSupabaseHeaders(),
      ...(options?.headers ?? {}),
    },
    body: JSON.stringify(body),
  });
}

export async function supabaseRestPost(
  pathWithQuery: string,
  body: unknown,
  options?: {
    headers?: Record<string, string>;
  },): Promise<Response> {
  const url = `${getSupabaseBaseUrl()}${pathWithQuery}`;
  return fetch(url, {
    method: "POST",
    headers: {
      ...getSupabaseHeaders(),
      ...(options?.headers ?? {}),
    },
    body: JSON.stringify(body),
  });
}

export async function supabaseRestDelete(
  pathWithQuery: string,
  options?: {
    headers?: Record<string, string>;
  },): Promise<Response> {
  const url = `${getSupabaseBaseUrl()}${pathWithQuery}`;
  return fetch(url, {
    method: "DELETE",
    headers: {
      ...getSupabaseHeaders(),
      ...(options?.headers ?? {}),
    },
  });
}

function getAltSupabaseConfig(): { url: string; serviceRoleKey: string } {
  const config = getConfig().altSupabase;
  if (!config) throw new Error("ALT Supabase is not configured");
  return config;
}

function getAltSupabaseHeaders(): Record<string, string> {
  const apiKey = getAltSupabaseConfig().serviceRoleKey;
  return {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function altSupabaseRequest(
  method: string,
  pathWithQuery: string,
  options?: { headers?: Record<string, string>; body?: unknown },
): Promise<Response> {
  const config = getAltSupabaseConfig();
  return fetch(`${config.url}${pathWithQuery}`, {
    method,
    headers: {
      ...getAltSupabaseHeaders(),
      ...(options?.headers ?? {}),
    },
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

export async function altSupabaseRestGet(
  pathWithQuery: string,
  options?: { headers?: Record<string, string> },
): Promise<Response> {
  return altSupabaseRequest("GET", pathWithQuery, options);
}

export async function altSupabaseRestGetAll<T>(
  pathWithQuery: string,
  options?: { pageSize?: number },
): Promise<T[]> {
  const pageSize = options?.pageSize ?? 1000;
  const rows: T[] = [];
  let from = 0;

  while (true) {
    const response = await altSupabaseRestGet(pathWithQuery, {
      headers: { Range: `${from}-${from + pageSize - 1}` },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Failed to fetch paginated ALT Supabase rows - HTTP ${response.status}: ${body}`,
      );
    }

    const pageRows = (await response.json()) as T[];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

export async function altSupabaseRestPatch(
  pathWithQuery: string,
  body: Record<string, unknown>,
  options?: { headers?: Record<string, string> },
): Promise<Response> {
  return altSupabaseRequest("PATCH", pathWithQuery, {
    headers: { Prefer: "return=minimal", ...(options?.headers ?? {}) },
    body,
  });
}
