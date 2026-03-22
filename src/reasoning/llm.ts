import OpenAI from 'openai';
import { config } from '../core/config.js';

const client = new OpenAI({ apiKey: config.openai.apiKey });

export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

interface LlmOptions {
  model?: 'routing' | 'reasoning';
  temperature?: number;
  maxTokens?: number;
}

export async function llmComplete(
  messages: LlmMessage[],
  options: LlmOptions = {},
): Promise<string> {
  const model = options.model === 'reasoning'
    ? config.openai.reasoningModel
    : config.openai.routingModel;

  const response = await client.chat.completions.create({
    model,
    messages,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? 1024,
  });

  return response.choices[0]?.message?.content?.trim() ?? '';
}

export async function llmJson<T>(
  messages: LlmMessage[],
  options: LlmOptions = {},
): Promise<T> {
  const model = options.model === 'reasoning'
    ? config.openai.reasoningModel
    : config.openai.routingModel;

  const response = await client.chat.completions.create({
    model,
    messages,
    temperature: options.temperature ?? 0,
    max_tokens: options.maxTokens ?? 1024,
    response_format: { type: 'json_object' },
  });

  const text = response.choices[0]?.message?.content?.trim() ?? '{}';
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}
