import type { ConnectionCredentials } from "../../../shared/db/connectionsDirectory.js";
import { GRAPH_API_BASE, appSecretProof, graphRequest, requireToken } from "./graph.js";

/**
 * Cliente de la API de plantillas de Meta (Message Templates), sin SDK —
 * mismo criterio que `outbound.ts` (ADR-033: son llamadas HTTP con JSON, una
 * dependencia no se paga). Vive en un archivo propio y no dentro de
 * `outbound.ts` porque no es parte del contrato `WebhookOutboundAdapter`
 * (`sendText`/`verifyCredentials`) que comparte con Twilio: la API de
 * plantillas es exclusiva de Meta, a nivel de WABA (no de `phone_number_id`),
 * y Twilio no tiene equivalente.
 */

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/**
 * El WABA ID (WhatsApp Business Account) vive en `credentials.wabaId` — un
 * campo aparte del `phone_number_id` que ya usa el envío de texto normal:
 * una cuenta de negocio puede tener varios números, y las plantillas se
 * gestionan a nivel de cuenta, no de número.
 */
export function requireWabaId(credentials: ConnectionCredentials): string {
  const { wabaId } = credentials;
  if (!wabaId) {
    throw new Error(
      "La conexión de Meta no tiene WhatsApp Business Account ID configurado — agregalo desde Conexiones.",
    );
  }
  return wabaId;
}

function appSecretProofParams(credentials: ConnectionCredentials, token: string): string {
  return credentials.appSecret ? `?appsecret_proof=${appSecretProof(token, credentials.appSecret)}` : "";
}

export interface CreateTemplatePayload {
  name: string;
  category: "UTILITY" | "MARKETING" | "AUTHENTICATION";
  language: string;
  components: Record<string, unknown>[];
}

interface CreateTemplateResponse {
  id?: string;
  status?: string;
}

/** POST {WABA}/message_templates — Meta responde con el id propio y el status inicial (normalmente "PENDING"). */
export async function createTemplate(
  credentials: ConnectionCredentials,
  payload: CreateTemplatePayload,
): Promise<{ externalTemplateId: string; status: string }> {
  const token = requireToken(credentials);
  const wabaId = requireWabaId(credentials);
  const body = await graphRequest<CreateTemplateResponse>(
    `${GRAPH_API_BASE}/${wabaId}/message_templates${appSecretProofParams(credentials, token)}`,
    { method: "POST", headers: authHeaders(token), body: JSON.stringify(payload) },
    "Meta rechazó la creación de la plantilla",
  );
  if (!body.id || !body.status) {
    throw new Error("Meta aceptó la plantilla pero no devolvió id ni status");
  }
  return { externalTemplateId: body.id, status: body.status };
}

interface TemplateStatusResponse {
  status?: string;
  rejected_reason?: string;
}

/** GET {TEMPLATE_ID}?fields=status,rejected_reason — para el botón "Sincronizar" del panel. */
export async function fetchTemplateStatus(
  credentials: ConnectionCredentials,
  externalTemplateId: string,
): Promise<{ status: string; rejectionReason: string | null }> {
  const token = requireToken(credentials);
  const body = await graphRequest<TemplateStatusResponse>(
    `${GRAPH_API_BASE}/${externalTemplateId}?fields=status,rejected_reason`,
    { headers: { Authorization: `Bearer ${token}` } },
    "Meta rechazó la consulta de estado",
  );
  if (!body.status) {
    throw new Error("Meta no devolvió el status de la plantilla");
  }
  const rejectionReason = body.rejected_reason && body.rejected_reason !== "NONE" ? body.rejected_reason : null;
  return { status: body.status, rejectionReason };
}

/** DELETE {WABA}/message_templates?name=... — Meta borra por nombre, no por id. */
export async function deleteTemplateOnMeta(
  credentials: ConnectionCredentials,
  name: string,
): Promise<void> {
  const token = requireToken(credentials);
  const wabaId = requireWabaId(credentials);
  await graphRequest(
    `${GRAPH_API_BASE}/${wabaId}/message_templates?name=${encodeURIComponent(name)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    "Meta rechazó la eliminación de la plantilla",
  );
}

export interface TemplateSendParam {
  type: "text";
  text: string;
}

interface SendTemplateResponse {
  messages?: Array<{ id?: string }>;
}

/**
 * POST {phone_number_id}/messages con type "template". Sin variables
 * (`bodyParams` vacío, el caso de `hello_world`) no se manda `components` en
 * absoluto — mandar `components: []` es una forma distinta y Meta la puede
 * rechazar según la plantilla.
 */
export async function sendTemplateMessage(
  credentials: ConnectionCredentials,
  phoneNumberId: string,
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams: TemplateSendParam[],
): Promise<string> {
  const token = requireToken(credentials);
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(bodyParams.length > 0 ? { components: [{ type: "body", parameters: bodyParams }] } : {}),
    },
  };
  const body = await graphRequest<SendTemplateResponse>(
    `${GRAPH_API_BASE}/${phoneNumberId}/messages`,
    { method: "POST", headers: authHeaders(token), body: JSON.stringify(payload) },
    "Meta rechazó el envío de la plantilla",
  );
  const id = body.messages?.[0]?.id;
  if (!id) {
    throw new Error("Meta aceptó el envío de la plantilla pero no devolvió un id de mensaje");
  }
  return id;
}
