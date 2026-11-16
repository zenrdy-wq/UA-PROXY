'use strict';
/**
 * Responses API bridge: lets an upstream that only speaks the OpenAI
 * Responses API (/v1/responses) also serve /v1/chat/completions clients.
 *
 * Incoming chat/completions requests are translated to Responses format and
 * the reply — JSON or SSE — is translated back, so ordinary chat clients
 * (and OpenAI-compatible chat channels) can use responses-only providers.
 *
 * Enable per upstream with `"chatVia": "responses"`; per request the client
 * can override with the `x-ua-chat-via: responses|off` header.
 */

const { randomUUID } = require('node:crypto');
const { createSseParser, SSE_FRAME_LIMIT } = require('./sse');

// ---------------- request: chat/completions -> responses ----------------

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && typeof part === 'object' && part.type === 'text')
      .map((part) => part.text || '')
      .join('');
  }
  return content == null ? '' : String(content);
}

/** Map chat content parts to Responses input parts; plain strings stay strings. */
function contentToInput(content, role) {
  if (typeof content === 'string' || typeof content === 'number') return String(content);
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  const textType = role === 'assistant' ? 'output_text' : 'input_text';
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') {
      parts.push({ type: textType, text: part.text ?? '' });
    } else if (part.type === 'image_url' && part.image_url && typeof part.image_url === 'object') {
      const image = { type: 'input_image', image_url: part.image_url.url };
      if (part.image_url.detail) image.detail = part.image_url.detail;
      parts.push(image);
    }
  }
  return parts.length ? parts : '';
}

function responseFormatToText(format) {
  if (format?.type === 'json_object') return { type: 'json_object' };
  if (format?.type === 'json_schema' && format.json_schema) {
    const out = { type: 'json_schema', name: format.json_schema.name };
    if (format.json_schema.schema) out.schema = format.json_schema.schema;
    if (format.json_schema.strict !== undefined) out.strict = format.json_schema.strict;
    return out;
  }
  return { type: 'text' };
}

function chatToResponses(body) {
  const out = { model: body.model };
  const input = [];
  const instructions = [];

  for (const msg of body.messages || []) {
    if (!msg) continue;
    if (msg.role === 'system' || msg.role === 'developer') {
      const text = contentToText(msg.content);
      if (text) instructions.push(text);
    } else if (msg.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
      });
    } else if (msg.role === 'assistant') {
      for (const call of msg.tool_calls || []) {
        if (!call || !call.function) continue;
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments ?? '{}',
        });
      }
      const content = contentToInput(msg.content, 'assistant');
      if (content !== '') input.push({ role: 'assistant', content });
    } else {
      input.push({ role: msg.role || 'user', content: contentToInput(msg.content, msg.role) });
    }
  }
  if (instructions.length) out.instructions = instructions.join('\n\n');
  out.input = input;

  if (Array.isArray(body.tools)) {
    out.tools = body.tools
      .map((tool) => tool?.type === 'function' && tool.function ? {
        type: 'function',
        name: tool.function.name,
        ...(tool.function.description ? { description: tool.function.description } : {}),
        ...(tool.function.parameters ? { parameters: tool.function.parameters } : {}),
        ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {}),
      } : tool)
      .filter(Boolean);
  }

  const toolChoice = body.tool_choice;
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
    out.tool_choice = toolChoice;
  } else if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function' && toolChoice.function) {
    out.tool_choice = { type: 'function', name: toolChoice.function.name };
  }

  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens != null) out.max_output_tokens = maxTokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.frequency_penalty != null) out.frequency_penalty = body.frequency_penalty;
  if (body.presence_penalty != null) out.presence_penalty = body.presence_penalty;
  if (body.parallel_tool_calls != null) out.parallel_tool_calls = body.parallel_tool_calls;
  if (body.reasoning_effort != null) out.reasoning = { effort: body.reasoning_effort };
  else if (body.reasoning && typeof body.reasoning === 'object') out.reasoning = body.reasoning;
  if (body.response_format) out.text = { format: responseFormatToText(body.response_format) };
  if (body.stream != null) out.stream = Boolean(body.stream);
  return out;
}

// ---------------- response: responses -> chat ----------------

function mapUsage(usage) {
  if (!usage) return undefined;
  const out = {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  };
  if (usage.input_tokens_details && usage.input_tokens_details.cached_tokens !== undefined) {
    out.prompt_tokens_details = { cached_tokens: usage.input_tokens_details.cached_tokens };
  }
  if (usage.output_tokens_details && usage.output_tokens_details.reasoning_tokens !== undefined) {
    out.completion_tokens_details = { reasoning_tokens: usage.output_tokens_details.reasoning_tokens };
  }
  return out;
}

function collectOutput(output) {
  const textParts = [];
  const toolCalls = [];
  for (const item of output || []) {
    if (!item) continue;
    if (item.type === 'message') {
      for (const part of item.content || []) {
        if (part && part.type === 'output_text' && part.text) textParts.push(part.text);
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || item.id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments ?? '{}' },
      });
    }
  }
  return { textParts, toolCalls };
}

function finishReason(response, toolCalls) {
  if (toolCalls.length) return 'tool_calls';
  const reason = response?.incomplete_details?.reason;
  if (reason === 'max_output_tokens') return 'length';
  if (reason === 'content_filter') return 'content_filter';
  return 'stop';
}

function responsesToChat(response, fallbackModel) {
  const { textParts, toolCalls } = collectOutput(response?.output);
  const message = { role: 'assistant', content: textParts.join('\n\n') };
  if (toolCalls.length) {
    if (!textParts.length) message.content = null;
    message.tool_calls = toolCalls;
  }
  return {
    id: 'chatcmpl-' + (response?.id || randomUUID()),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response?.model || fallbackModel || '',
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason(response, toolCalls),
    }],
    usage: mapUsage(response?.usage)
      || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------- streaming: responses SSE -> chat/completions SSE ----------------

/**
 * Stateful translator fed with Responses SSE payloads. Emits chat completion
 * chunks through write(); call end() once the upstream stream closes.
 */
function createStreamTranslator({ model, includeUsage = true, write, onEvent = () => {} }) {
  const id = 'chatcmpl-' + randomUUID().replace(/-/g, '');
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: 'chat.completion.chunk', created, model: model || '' };
  let started = false;
  let finished = false;
  const toolIndex = new Map();
  let toolCount = 0;

  const chunk = (delta, finishReason = null, usage = undefined) => {
    const out = { ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] };
    if (usage) out.usage = usage;
    write('data: ' + JSON.stringify(out) + '\n\n');
  };
  const emitDone = () => {
    if (finished) return;
    finished = true;
    write('data: [DONE]\n\n');
  };
  const toolIndexFor = (item) => {
    if (!toolIndex.has(item.id)) toolIndex.set(item.id, toolCount++);
    return toolIndex.get(item.id);
  };

  const handleItemAdded = (item) => {
    if (!item || item.type !== 'function_call') return;
    const index = toolIndexFor(item);
    if (item.call_id && item.name) {
      chunk({
        tool_calls: [{
          index,
          id: item.call_id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments || '' },
        }],
      });
    }
  };

  const finishTurn = (response) => {
    const { toolCalls } = collectOutput(response?.output);
    if (!started) { started = true; chunk({ role: 'assistant', content: '' }); }
    chunk({}, finishReason(response, toolCalls));
    if (includeUsage) {
      const usage = mapUsage(response?.usage);
      if (usage) write('data: ' + JSON.stringify({ ...base, choices: [], usage }) + '\n\n');
    }
    emitDone();
    onEvent('completed');
  };

  const handlers = {
    'response.created'() {
      if (started) return;
      started = true;
      chunk({ role: 'assistant', content: '' });
    },
    'response.output_item.added': (evt) => handleItemAdded(evt.item),
    'response.output_text.delta': (evt) => {
      if (!started) { started = true; chunk({ role: 'assistant', content: '' }); }
      if (evt.delta) chunk({ content: evt.delta });
    },
    'response.function_call_arguments.delta': (evt) => {
      const item = { id: evt.item_id || evt.id || 'item' };
      chunk({ tool_calls: [{ index: toolIndexFor(item), function: { arguments: evt.delta || '' } }] });
    },
    'response.function_call_arguments.done': () => {},
    // Both are legitimate ends of a turn: `response.incomplete` is used
    // when a limit is reached (e.g. max output tokens).
    'response.completed': (evt) => finishTurn(evt.response),
    'response.incomplete': (evt) => finishTurn(evt.response),
    'response.failed': (evt) => {
      const err = evt.response?.error || {};
      write('data: ' + JSON.stringify({
        error: { message: err.message || 'upstream request failed', type: err.type || 'upstream_error', code: err.code ?? null },
      }) + '\n\n');
      emitDone();
      onEvent('failed');
    },
    'error': (evt) => {
      write('data: ' + JSON.stringify({ error: evt.error || { message: 'upstream request failed' } }) + '\n\n');
      emitDone();
      onEvent('failed');
    },
  };

  return {
    event(payload) {
      if (finished || !payload) return;
      let evt;
      try { evt = JSON.parse(payload); } catch { return; }
      if (!evt || typeof evt !== 'object') return;
      const handler = handlers[evt.type];
      if (handler) handler(evt);
      else if (!started && evt.response?.model) handlers['response.created']();
    },
    end() {
      if (!finished) {
        chunk({}, 'stop');
        emitDone();
        onEvent('incomplete');
      }
    },
  };
}

/**
 * Wire an upstream Responses SSE stream to a chat/completions client response.
 * Returns push(chunk) / end() and keeps a heartbeat alive between events.
 */
function createBridgedStream({ model, includeUsage, res, heartbeat, activity, onDrop = null }) {
  let completed = false;
  const translator = createStreamTranslator({
    model,
    includeUsage,
    write: (payload) => res.write(payload),
    onEvent: (kind) => { if (kind === 'completed') completed = true; },
  });
  const parser = createSseParser(({ data }) => {
    if (data === '[DONE]' || data === 'null') return;
    translator.event(data);
  }, { maxFrame: SSE_FRAME_LIMIT, strict: false, onDrop });
  return {
    push(chunk) { heartbeat.touch(); parser.push(chunk); },
    end() {
      parser.end();
      translator.end();
      heartbeat.stop();
      if (!completed) activity.error(502, { code: 'stream_incomplete' });
      res.end();
    },
  };
}

/**
 * Replay a complete Responses payload as a chat/completions SSE stream,
 * for clients that asked to stream but got a single JSON body.
 */
function emitResponseAsChatStream(response, { model, includeUsage = true }, write) {
  const translator = createStreamTranslator({ model, includeUsage, write });
  translator.event(JSON.stringify({ type: 'response.created' }));
  for (const item of response?.output || []) {
    if (item?.type === 'message') {
      for (const part of item.content || []) {
        if (part?.type === 'output_text' && part.text) {
          translator.event(JSON.stringify({ type: 'response.output_text.delta', delta: part.text }));
        }
      }
    } else if (item?.type === 'function_call') {
      translator.event(JSON.stringify({ type: 'response.output_item.added', item }));
    }
  }
  translator.event(JSON.stringify({ type: 'response.completed', response: response || {} }));
}

module.exports = {
  chatToResponses,
  responsesToChat,
  createStreamTranslator,
  createBridgedStream,
  emitResponseAsChatStream,
  mapUsage,
};
