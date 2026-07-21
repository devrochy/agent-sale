import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env.js";

export const claude = new Anthropic({ apiKey: env.anthropicApiKey });
