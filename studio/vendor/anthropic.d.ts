// Hand-written types for anthropic.js (@anthropic-ai/sdk, bundled by scripts/vendor): the part of the beta Messages
// streaming API the AI builder (builder.ts) uses, with the SDK's names.
export interface TextBlock { type: "text"; text: string }
export interface ThinkingBlock { type: "thinking"; thinking: string; signature: string }
export interface RedactedThinkingBlock { type: "redacted_thinking"; data: string }
export interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
export type ContentBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock;

export interface ToolResultBlockParam { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
export type ContentBlockParam = ContentBlock | ToolResultBlockParam;
export interface MessageParam { role: "user" | "assistant"; content: string | ContentBlockParam[] }

export type StopReason =
  | "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal" | "model_context_window_exceeded";
export interface Message { content: ContentBlock[]; stop_reason: StopReason | null }

export interface Tool {
  name: string;
  description: string;
  eager_input_streaming?: boolean;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
}

export interface MessageStreamParams {
  model: string;
  max_tokens: number;
  system: string;
  tools: Tool[];
  messages: MessageParam[];
  output_config?: { effort?: "low" | "medium" | "high" | "max" };
  cache_control?: { type: "ephemeral" };
  betas?: string[];
  fallbacks?: "default";
}

export type RawContentBlockDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string };
export type MessageStreamEvent =
  | { type: "content_block_start"; index: number; content_block: ContentBlock }
  | { type: "content_block_delta"; index: number; delta: RawContentBlockDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_start" | "message_delta" | "message_stop" };

export interface MessageStream {
  on(event: "text", listener: (delta: string) => void): this;
  on(event: "streamEvent", listener: (event: MessageStreamEvent) => void): this;
  finalMessage(): Promise<Message>;
}

export interface ClientOptions {
  apiKey?: string | null;
  authToken?: string | null;
  baseURL?: string;
  dangerouslyAllowBrowser?: boolean;
}

export declare class Anthropic {
  constructor(options?: ClientOptions);
  readonly beta: {
    readonly messages: {
      stream(params: MessageStreamParams, options?: { signal?: AbortSignal }): MessageStream;
    };
  };
}
