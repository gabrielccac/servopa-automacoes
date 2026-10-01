function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function getOptionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (value === "..." || value.toLowerCase() === "null") return null;
  try {
    new URL(value);
    return value;
  } catch {
    return null;
  }
}

function getOptionalRawEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (value === "..." || value.toLowerCase() === "null") return null;
  return value;
}

const DEFAULT_ZAPI_BASE_URL = "https://api.z-api.io";

export interface AppConfig {
  servopa: {
    cpfCnpj: string;
    senha: string;
  };
  supabase: {
    url: string;
    serviceRoleKey: string;
  };
  altSupabase: {
    url: string;
    serviceRoleKey: string;
  } | null;
  zapi: {
    baseUrl: string;
    instanceId: string;
    instanceToken: string;
    clientToken: string;
    executionSummaryPhone: string | null;
    restoreDeliveryWebhookUrl: string | null;
    deliveryWaitTimeout: string;
  };
}

let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const executionSummaryPhone = getOptionalRawEnv("ZAPI_EXECUTION_SUMMARY_PHONE");

  cachedConfig = {
    servopa: {
      cpfCnpj: getRequiredEnv("SERVOPA_CPF_CNPJ"),
      senha: getRequiredEnv("SERVOPA_SENHA"),
    },
    supabase: {
      url: getRequiredEnv("SUPABASE_URL"),
      serviceRoleKey: getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    },
    altSupabase:
      getOptionalEnv("ALT_SUPABASE_URL") && getOptionalRawEnv("ALT_SUPABASE_SERVICE_ROLE_KEY")
        ? {
            url: getOptionalEnv("ALT_SUPABASE_URL")!,
            serviceRoleKey: getOptionalRawEnv("ALT_SUPABASE_SERVICE_ROLE_KEY")!,
          }
        : null,
    zapi: {
      baseUrl: process.env.ZAPI_BASE_URL?.trim() ?? DEFAULT_ZAPI_BASE_URL,
      instanceId: getRequiredEnv("ZAPI_INSTANCE_ID"),
      instanceToken: getRequiredEnv("ZAPI_INSTANCE_TOKEN"),
      clientToken: getRequiredEnv("ZAPI_CLIENT_TOKEN"),
      executionSummaryPhone,
      restoreDeliveryWebhookUrl: getOptionalEnv("ZAPI_DELIVERY_WEBHOOK_RESTORE_URL"),
      deliveryWaitTimeout: process.env.ZAPI_DELIVERY_WAIT_TIMEOUT?.trim() ?? "5m",
    },
  };

  return cachedConfig;
}
