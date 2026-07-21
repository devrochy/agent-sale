import { env } from "../../config/env.js";
import { AnthropicProvider } from "./anthropicProvider.js";
import { OpenAICompatibleProvider } from "./openaiCompatibleProvider.js";
import type { LLMProvider } from "./types.js";

export const llmProvider: LLMProvider =
  env.llmProvider === "openai_compatible" ? new OpenAICompatibleProvider() : new AnthropicProvider();

export type { ContentBlock, LLMMessage, ToolDefinition, TurnResponse } from "./types.js";
