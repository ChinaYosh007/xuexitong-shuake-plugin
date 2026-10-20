export type AiProtocol = "CHAT_COMPLETIONS" | "RESPONSES";
export type InstructionRole = "system" | "developer";
export type OutputMode = "JSON_SCHEMA" | "JSON_OBJECT" | "PROMPT_JSON";
export type TokenLimitField = "max_tokens" | "max_completion_tokens" | "max_output_tokens";
export type VerificationStatus = "UNVERIFIED" | "VERIFIED";

export interface ProviderCapabilities {
  instructionRole: InstructionRole;
  outputMode: OutputMode;
  tokenLimitField: TokenLimitField;
  supportsTemperature: boolean;
  supportsStoreFalse: boolean;
}

export interface ProviderGeneration {
  maxOutputTokens: number;
  temperature: number | null;
}

export interface ProviderProfileWrite {
  name: string;
  baseUrl: string;
  protocol: AiProtocol;
  model: string;
  enabled: boolean;
  capabilities: ProviderCapabilities;
  generation: ProviderGeneration;
}

export interface ProviderVerification {
  status: VerificationStatus;
  verifiedVersion: number | null;
  testedAt: string | null;
}

export interface ProviderProfile extends ProviderProfileWrite {
  id: string;
  version: number;
  hasKey: boolean;
  verification: ProviderVerification;
  createdAt: string;
  updatedAt: string;
}

export interface SaveSecretRequest {
  apiKey: string;
}

export interface ProbeRequest {
  expectedVersion: number;
  acknowledgePossibleCharge: true;
}

export interface ProbeResponse {
  status: VerificationStatus;
  profileVersion: number;
  testedAt: string;
  latencyMs: number;
}

export interface ProviderCatalogEntry {
  rootUrl: string;
  label: string;
}

export interface SetDefaultProviderRequest {
  profileId: string | null;
}

export interface UsageSummary {
  from: string;
  to: string;
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}
/** GET /provider-profiles/{id}/models — uses the stored key; the key is never returned. */
export interface ProviderModelList {
  models: string[];
}
