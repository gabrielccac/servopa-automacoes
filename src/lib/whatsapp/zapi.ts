import type { AppConfig } from "../config.js";
import { getConfig } from "../config.js";

export type ZApiConfig = AppConfig["zapi"];

export interface HasIds {
  messageId?: string;
  zaapId?: string;
  id?: string;
}

export interface ZApiSendTextResponse {
  zaapId?: string;
  messageId?: string;
  id?: string;
  [key: string]: unknown;
}

export type ZApiButtonAction =
  | {
      id: string;
      type: "URL";
      url: string;
      label: string;
    }
  | {
      id: string;
      type: "REPLY";
      label: string;
    };

export interface ZApiSendButtonActionsInput {
  phone: string;
  message: string;
  buttonActions: ZApiButtonAction[];
}

export interface ZApiDeliveryCallbackPayload {
  phone?: string;
  zaapId?: string;
  messageId?: string;
  instanceId?: string;
  momment?: number;
  type?: string;
  error?: string;
  [key: string]: unknown;
}

export interface ZApiNormalizedDeliveryResult {
  accepted: boolean;
  deliveryConfirmed: boolean;
  deliveryFailed: boolean;
  callbackMatchedToSend: boolean;
  status: "accepted" | "deliveryConfirmed" | "deliveryFailed";
  error: string | null;
}

function buildZApiUrl(config: ZApiConfig, path: string): string {
  return `${config.baseUrl}/instances/${config.instanceId}/token/${config.instanceToken}${path}`;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function zapiRequest<T>(
  config: ZApiConfig,
  path: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(buildZApiUrl(config, path), {
    ...init,
    headers: {
      "Client-Token": config.clientToken,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      `Z-API request failed for ${path} - HTTP ${response.status} - ${JSON.stringify(payload)}`,
    );
  }

  return payload as T;
}

export function getZApiConfig(): ZApiConfig {
  return getConfig().zapi;
}

export async function sendExecutionSummary(message: string): Promise<void> {
  const normalizedMessage = String(message || "").trim();
  if (!normalizedMessage) return;

  const config = getZApiConfig();
  if (!config.executionSummaryPhone) {
    throw new Error("Missing required env var: ZAPI_EXECUTION_SUMMARY_PHONE");
  }

  await sendTextMessage(config, {
    phone: config.executionSummaryPhone,
    message: normalizedMessage,
  });
}

export async function updateDeliveryWebhook(
  config: ZApiConfig,
  webhookUrl: string,
): Promise<unknown> {
  return zapiRequest(config, "/update-webhook-delivery", {
    method: "PUT",
    body: JSON.stringify({ value: webhookUrl }),
  });
}

export async function sendTextMessage(
  config: ZApiConfig,
  input: { phone: string; message: string },
): Promise<ZApiSendTextResponse> {
  return zapiRequest<ZApiSendTextResponse>(config, "/send-text", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function sendButtonActionsMessage(
  config: ZApiConfig,
  input: ZApiSendButtonActionsInput,
): Promise<ZApiSendTextResponse> {
  return zapiRequest<ZApiSendTextResponse>(config, "/send-button-actions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function normalizeDeliveryResult(input: {
  sendResponse: ZApiSendTextResponse;
  deliveryCallback: ZApiDeliveryCallbackPayload;
}): ZApiNormalizedDeliveryResult {
  const { sendResponse, deliveryCallback } = input;

  const accepted = Boolean(
    sendResponse.messageId || sendResponse.zaapId || sendResponse.id,
  );
  const callbackHasError = Boolean(deliveryCallback.error);
  const callbackMatchedToSend = Boolean(
    (sendResponse.zaapId &&
      deliveryCallback.zaapId &&
      sendResponse.zaapId === deliveryCallback.zaapId) ||
      (sendResponse.messageId &&
        deliveryCallback.messageId &&
        sendResponse.messageId === deliveryCallback.messageId) ||
      (sendResponse.id &&
        deliveryCallback.messageId &&
        sendResponse.id === deliveryCallback.messageId),
  );

  const deliveryConfirmed = accepted && !callbackHasError;
  const deliveryFailed = callbackHasError;

  return {
    accepted,
    deliveryConfirmed,
    deliveryFailed,
    callbackMatchedToSend,
    status: deliveryFailed
      ? "deliveryFailed"
      : deliveryConfirmed
        ? "deliveryConfirmed"
        : "accepted",
    error: callbackHasError ? String(deliveryCallback.error) : null,
  };
}

export function getSendResponseExternalId(sendResponse: HasIds | null): string | null {
  if (!sendResponse) return null;
  const candidate = sendResponse.messageId ?? sendResponse.zaapId ?? sendResponse.id;
  return candidate ? String(candidate) : null;
}
