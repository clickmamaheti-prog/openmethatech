// Stateful stream XML parser for agent tool calls.
//
// Ported (adapted, not copied verbatim) from Freebuff, Apache-2.0:
//   packages/agent-runtime/src/util/stream-xml-parser.ts
//   (createStreamParserState / parseStreamChunk / parseToolCallContent /
//   findPartialTagMatch), with tag/param names from
//   common/src/tools/constants.ts:
//     toolXmlName  = 'codebuff_tool_call'
//     toolNameParam = 'cb_tool_name'
//     endsAgentStepParam = 'cb_easp'
//
// Freebuff matches the tags flexibly (no required newlines); this port
// keeps that behaviour. The tag body is JSON: the tool name under
// `cb_tool_name`, the rest of the keys are the tool input.
//
// MethaTech differences:
// - Runs on Node (no Bun / OpenTUI dependency), pure TypeScript.
// - Malformed JSON inside a closed tag is reported as a parse error
//   (Freebuff silently drops it); the agent loop turns that error into
//   a TOOL_CALL_ERROR message so the model can retry (AGENT-ADOPTION.md
//   §2.1), instead of silently losing the call.

export const TOOL_XML_NAME = "codebuff_tool_call";
export const TOOL_NAME_PARAM = "cb_tool_name";
export const ENDS_AGENT_STEP_PARAM = "cb_easp";

const START_TAG = `<${TOOL_XML_NAME}>`;
const END_TAG = `</${TOOL_XML_NAME}>`;

export interface ParsedToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

export interface StreamParserState {
  /** Holds partial content at a chunk boundary / inside a tool tag. */
  buffer: string;
  /** True while inside a `<codebuff_tool_call>` tag. */
  insideToolCall: boolean;
}

export interface ParseResult {
  /** Text with tool-call XML removed. */
  filteredText: string;
  /** Tool calls completed by this chunk. */
  toolCalls: ParsedToolCall[];
  /** JSON that failed to parse inside a closed tag (one per bad tag). */
  parseErrors: string[];
}

export function createStreamParserState(): StreamParserState {
  return { buffer: "", insideToolCall: false };
}

/**
 * Feed one stream chunk through the parser. The state is mutated in
 * place (Freebuff pattern); call once per SSE delta, in order.
 */
export function parseStreamChunk(chunk: string, state: StreamParserState): ParseResult {
  if (!chunk) return { filteredText: "", toolCalls: [], parseErrors: [] };

  let text = state.buffer + chunk;
  state.buffer = "";

  let filteredText = "";
  const toolCalls: ParsedToolCall[] = [];
  const parseErrors: string[] = [];

  while (text.length > 0) {
    if (state.insideToolCall) {
      const endIndex = text.indexOf(END_TAG);
      if (endIndex !== -1) {
        const content = text.slice(0, endIndex);
        const parsed = parseToolCallContent(content);
        if (parsed) toolCalls.push(parsed);
        else if (content.trim().length > 0) parseErrors.push(content.trim().slice(0, 500));
        text = text.slice(endIndex + END_TAG.length);
        state.insideToolCall = false;
      } else {
        state.buffer = text;
        text = "";
      }
    } else {
      const startIndex = text.indexOf(START_TAG);
      if (startIndex !== -1) {
        filteredText += text.slice(0, startIndex);
        text = text.slice(startIndex + START_TAG.length);
        state.insideToolCall = true;
      } else {
        const partial = findPartialTagMatch(text, START_TAG);
        if (partial > 0) {
          filteredText += text.slice(0, -partial);
          state.buffer = text.slice(-partial);
          text = "";
        } else {
          filteredText += text;
          text = "";
        }
      }
    }
  }

  return { filteredText, toolCalls, parseErrors };
}

/** Parse the JSON body of one closed tag. Null when not valid tool JSON. */
function parseToolCallContent(content: string): ParsedToolCall | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const toolName = parsed[TOOL_NAME_PARAM];
    if (typeof toolName !== "string" || toolName.length === 0) return null;
    const input = { ...parsed };
    delete input[TOOL_NAME_PARAM];
    delete input[ENDS_AGENT_STEP_PARAM];
    return { toolName, input };
  } catch {
    return null;
  }
}

/** Length of the longest suffix of `text` that is a prefix of `tag`. */
function findPartialTagMatch(text: string, tag: string): number {
  const maxOverlap = Math.min(text.length, tag.length - 1);
  for (let len = maxOverlap; len > 0; len--) {
    if (text.slice(-len) === tag.slice(0, len)) return len;
  }
  return 0;
}

/**
 * Convenience wrapper for a complete (non-streamed) response: parse the
 * whole text at once and return everything the parser found.
 */
export function parseFullText(text: string): ParseResult {
  const state = createStreamParserState();
  const result = parseStreamChunk(text, state);
  // A dangling unclosed tag holds its content in the buffer; surface it
  // as a parse error instead of silently dropping the model's intent.
  if (state.insideToolCall && state.buffer.trim().length > 0) {
    result.parseErrors.push(`unclosed <${TOOL_XML_NAME}> tag: ${state.buffer.trim().slice(0, 500)}`);
  }
  return result;
}

/** Serialise one tool call the way the model is instructed to emit it. */
export function formatToolCall(toolName: string, input: Record<string, unknown>): string {
  return `<${TOOL_XML_NAME}>\n${JSON.stringify({ [TOOL_NAME_PARAM]: toolName, ...input }, null, 2)}\n</${TOOL_XML_NAME}>`;
}
