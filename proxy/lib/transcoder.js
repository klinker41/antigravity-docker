'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

/**
 * Determines whether an Anthropic model requires adaptive thinking (Claude 4.6+, 5+, Fable).
 */
function isAdaptiveThinkingModel(modelName) {
    if (!modelName || typeof modelName !== 'string') return false;
    const lower = modelName.toLowerCase();
    if (lower.includes('fable')) return true;
    const match = lower.match(/(?:opus|sonnet|haiku)-([0-9]+)(?:[.-]([0-9]+))?/) ||
                  lower.match(/claude-([0-9]+)(?:[.-]([0-9]+))?-(?:opus|sonnet|haiku)/);
    if (match) {
        const major = parseInt(match[1], 10);
        const minor = match[2] ? parseInt(match[2], 10) : 0;
        if (major > 4 || (major === 4 && minor >= 6)) return true;
    }
    return false;
}

/**
 * Streams chat completion from an Anthropic Messages endpoint and normalizes events.
 */
function callAnthropicStream(options) {
    const { endpoint, apiKey, model, messages, system, tools, supportsThinking, maxTokens = 4096, onEvent } = options;

    let cleanBase = (endpoint || 'https://api.anthropic.com').trim().replace(/\/+$/, '');
    cleanBase = cleanBase.replace(/\/+(v1(\/(messages|models))?)?$/, '');
    const targetUrl = `${cleanBase}/v1/messages`;

    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === 'https:' ? https : http;

    const useAdaptiveThinking = options.thinkingType === 'adaptive' ||
        (options.thinkingType !== 'enabled' && isAdaptiveThinkingModel(model));

    const payload = {
        model,
        messages,
        max_tokens: maxTokens,
        stream: true
    };
    if (supportsThinking) {
        if (useAdaptiveThinking) {
            payload.thinking = { type: 'adaptive' };
        } else {
            payload.thinking = { type: 'enabled', budget_tokens: 2048 };
        }
        payload.max_tokens = Math.max(maxTokens, 4096);
    }
    if (system) payload.system = system;
    if (tools && tools.length > 0) payload.tools = tools;

    const body = JSON.stringify(payload);
    const headers = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
    };
    if (apiKey) headers['x-api-key'] = apiKey;

    return new Promise((resolve, reject) => {
        const req = transport.request(parsed, { method: 'POST', headers, timeout: 60000 }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                let errBody = '';
                res.on('data', chunk => errBody += chunk);
                res.on('end', () => {
                    if (res.statusCode === 400 && supportsThinking && !options._thinkingRetried) {
                        if (errBody.includes('thinking.type.adaptive') && !useAdaptiveThinking) {
                            return resolve(callAnthropicStream({ ...options, thinkingType: 'adaptive', _thinkingRetried: true }));
                        }
                        if (errBody.includes('adaptive thinking is not supported') && useAdaptiveThinking) {
                            return resolve(callAnthropicStream({ ...options, thinkingType: 'enabled', _thinkingRetried: true }));
                        }
                    }
                    reject(new Error(`Anthropic error (${res.statusCode}): ${errBody}`));
                });
                return;
            }

            let buffer = '';
            let currentEvent = null;
            let currentBlocks = {}; // index -> { type, id, name, inputJson }

            res.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                const lines = buffer.split('\n');
                buffer = lines.pop(); // Keep uncompleted line

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) {
                        currentEvent = null;
                        continue;
                    }

                    if (trimmed.startsWith('event:')) {
                        currentEvent = trimmed.slice(6).trim();
                        continue;
                    }

                    if (trimmed.startsWith('data:')) {
                        const dataStr = trimmed.slice(5).trim();
                        try {
                            const data = JSON.parse(dataStr);
                            const evType = currentEvent || data.type;

                            if (evType === 'content_block_start') {
                                const idx = data.index;
                                const block = data.content_block || {};
                                currentBlocks[idx] = {
                                    type: block.type,
                                    id: block.id,
                                    name: block.name,
                                    inputJson: ''
                                };
                            } else if (evType === 'content_block_delta') {
                                const idx = data.index;
                                const delta = data.delta || {};
                                const block = currentBlocks[idx] || {};

                                if (delta.type === 'thinking_delta') {
                                    onEvent({ type: 'thought', text: delta.thinking || '' });
                                } else if (delta.type === 'text_delta') {
                                    onEvent({ type: 'text', text: delta.text || '' });
                                } else if (delta.type === 'input_json_delta') {
                                    block.inputJson = (block.inputJson || '') + (delta.partial_json || '');
                                }
                            } else if (evType === 'content_block_stop') {
                                const idx = data.index;
                                const block = currentBlocks[idx];
                                if (block && block.type === 'tool_use') {
                                    onEvent({
                                        type: 'tool_call',
                                        id: block.id,
                                        name: block.name,
                                        arguments: block.inputJson || '{}'
                                    });
                                }
                                delete currentBlocks[idx];
                            } else if (evType === 'message_delta') {
                                onEvent({
                                    type: 'done',
                                    stopReason: data.delta?.stop_reason || 'end_turn'
                                });
                            }
                        } catch (e) {}
                    }
                }
            });

            res.on('end', () => resolve());
            res.on('error', reject);
        });

        req.on('timeout', () => {
            req.destroy(new Error('Anthropic request timed out after 60 seconds'));
        });
        req.on('error', reject);

        if (options.signal) {
            if (options.signal.aborted) {
                req.destroy(new Error('Aborted by client'));
            } else {
                options.signal.addEventListener('abort', () => {
                    req.destroy(new Error('Aborted by client'));
                });
            }
        }

        req.write(body);
        req.end();
    });
}

const RESPONSES_API_MODELS = new Set();

/**
 * Determines whether an OpenAI model requires the /v1/responses endpoint (gpt-6, o1, o3, astra).
 * Excludes third-party local endpoints like Ollama unless explicitly remembered.
 */
function isOpenAIResponsesModel(modelName, endpoint) {
    if (!modelName || typeof modelName !== 'string') return false;
    const lower = modelName.toLowerCase();
    if (RESPONSES_API_MODELS.has(lower)) return true;

    if (endpoint && (endpoint.includes('ollama') || endpoint.includes(':11434'))) {
        return false;
    }

    return lower.startsWith('gpt-6') || lower.startsWith('o1') || lower.startsWith('o3') || lower.includes('astra');
}

/**
 * Converts standard ChatML messages to OpenAI Responses API input items.
 */
function chatMessagesToResponsesInput(messages) {
    if (!Array.isArray(messages)) return [];
    const input = [];
    for (const m of messages) {
        if (!m) continue;
        if (m.role === 'system') {
            if (m.content) input.push({ role: 'system', content: String(m.content) });
        } else if (m.role === 'user') {
            input.push({ role: 'user', content: m.content });
        } else if (m.role === 'assistant') {
            if (m.content) {
                input.push({ role: 'assistant', content: String(m.content) });
            }
            if (Array.isArray(m.tool_calls)) {
                for (const tc of m.tool_calls) {
                    const fnName = tc.function?.name || tc.name || '';
                    const fnArgs = typeof tc.function?.arguments === 'string'
                        ? tc.function.arguments
                        : JSON.stringify(tc.function?.arguments || {});
                    input.push({
                        type: 'function_call',
                        call_id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`,
                        name: fnName,
                        arguments: fnArgs
                    });
                }
            }
        } else if (m.role === 'tool') {
            input.push({
                type: 'function_call_output',
                call_id: m.tool_call_id || 'call_unknown',
                output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || {})
            });
        }
    }
    return input;
}

/**
 * Adapts tool definitions to OpenAI Responses API format ({ type: 'function', name, description, parameters }).
 */
function chatToolsToResponsesTools(tools) {
    if (!Array.isArray(tools)) return undefined;
    const respTools = [];
    for (const t of tools) {
        if (!t) continue;
        if (t.function) {
            respTools.push({
                type: 'function',
                name: t.function.name,
                description: t.function.description || '',
                parameters: t.function.parameters || { type: 'object', properties: {} }
            });
        } else if (t.type === 'function') {
            respTools.push(t);
        }
    }
    return respTools.length > 0 ? respTools : undefined;
}

/**
 * Streams chat completion from an OpenAI Responses API endpoint (/v1/responses).
 */
function callOpenAIResponsesStream(options) {
    const { endpoint, apiKey, model, messages, tools, maxTokens, onEvent } = options;

    let cleanBase = (endpoint || 'https://api.openai.com').trim().replace(/\/+$/, '');
    cleanBase = cleanBase.replace(/\/+(v1(\/(chat\/completions|responses|models))?)?$/, '');
    const targetUrl = `${cleanBase}/v1/responses`;

    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === 'https:' ? https : http;

    const input = Array.isArray(options.input) ? options.input : chatMessagesToResponsesInput(messages);
    const respTools = options.responsesTools || chatToolsToResponsesTools(tools);

    const payload = {
        model,
        input,
        stream: true
    };
    if (respTools && respTools.length > 0) payload.tools = respTools;
    if (maxTokens) payload.max_output_tokens = maxTokens;

    const body = JSON.stringify(payload);
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    return new Promise((resolve, reject) => {
        const req = transport.request(parsed, { method: 'POST', headers, timeout: 60000 }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                let errBody = '';
                res.on('data', chunk => errBody += chunk);
                res.on('end', () => {
                    if (res.statusCode === 404 && !options._chatCompletionsRetried) {
                        return resolve(callOpenAIStream({ ...options, _chatCompletionsRetried: true, forceChatCompletions: true }));
                    }
                    reject(new Error(`OpenAI Responses error (${res.statusCode}): ${errBody}`));
                });
                return;
            }

            let buffer = '';
            let hasCompleted = false;
            let currentEvent = null;
            const pendingFunctionCalls = {}; // item_id -> { id, name, args }

            res.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) {
                        currentEvent = null;
                        continue;
                    }

                    if (trimmed.startsWith('event:')) {
                        currentEvent = trimmed.slice(6).trim();
                        continue;
                    }

                    if (trimmed.startsWith('data:')) {
                        const dataStr = trimmed.slice(5).trim();
                        if (dataStr === '[DONE]') {
                            if (!hasCompleted) {
                                hasCompleted = true;
                                onEvent({ type: 'done' });
                            }
                            continue;
                        }

                        try {
                            const data = JSON.parse(dataStr);
                            const evType = currentEvent || data.type;

                            if (evType === 'response.output_text.delta') {
                                if (data.delta) onEvent({ type: 'text', text: data.delta });
                            } else if (evType === 'response.reasoning_summary_text.delta' || evType === 'response.reasoning_text.delta') {
                                if (data.delta) onEvent({ type: 'thought', text: data.delta });
                            } else if (evType === 'response.output_item.added') {
                                const item = data.item || {};
                                if (item.type === 'function_call') {
                                    pendingFunctionCalls[item.id] = {
                                        id: item.call_id || item.id,
                                        name: item.name || '',
                                        args: item.arguments || ''
                                    };
                                }
                            } else if (evType === 'response.function_call_arguments.delta') {
                                const itemId = data.item_id;
                                if (!pendingFunctionCalls[itemId]) {
                                    pendingFunctionCalls[itemId] = { id: '', name: '', args: '' };
                                }
                                pendingFunctionCalls[itemId].args += (data.delta || '');
                            } else if (evType === 'response.function_call_arguments.done') {
                                const itemId = data.item_id;
                                if (pendingFunctionCalls[itemId] && data.arguments) {
                                    pendingFunctionCalls[itemId].args = data.arguments;
                                }
                            } else if (evType === 'response.output_item.done') {
                                const item = data.item || {};
                                if (item.type === 'function_call') {
                                    const pending = pendingFunctionCalls[item.id] || {};
                                    onEvent({
                                        type: 'tool_call',
                                        id: item.call_id || pending.id || item.id,
                                        name: item.name || pending.name,
                                        arguments: item.arguments || pending.args || '{}'
                                    });
                                    delete pendingFunctionCalls[item.id];
                                }
                            } else if (evType === 'response.completed') {
                                for (const itemId of Object.keys(pendingFunctionCalls)) {
                                    const tc = pendingFunctionCalls[itemId];
                                    onEvent({
                                        type: 'tool_call',
                                        id: tc.id || itemId,
                                        name: tc.name,
                                        arguments: tc.args || '{}'
                                    });
                                    delete pendingFunctionCalls[itemId];
                                }
                                if (!hasCompleted) {
                                    hasCompleted = true;
                                    const status = data.response?.status;
                                    const finishReason = status === 'completed' ? 'STOP' : (status ? String(status).toUpperCase() : 'STOP');
                                    onEvent({ type: 'done', finishReason });
                                }
                            }
                        } catch (e) {}
                    }
                }
            });

            res.on('end', () => {
                if (!hasCompleted) {
                    hasCompleted = true;
                    onEvent({ type: 'done' });
                }
                resolve();
            });
            res.on('error', reject);
        });

        req.on('timeout', () => {
            req.destroy(new Error('OpenAI Responses request timed out after 60 seconds'));
        });
        req.on('error', reject);

        if (options.signal) {
            if (options.signal.aborted) {
                req.destroy(new Error('Aborted by client'));
            } else {
                options.signal.addEventListener('abort', () => {
                    req.destroy(new Error('Aborted by client'));
                });
            }
        }

        req.write(body);
        req.end();
    });
}

/**
 * Streams chat completion from an OpenAI-compatible endpoint and normalizes events.
 */
function callOpenAIStream(options) {
    const { endpoint, apiKey, model, messages, tools, maxTokens, onEvent } = options;

    if (!options.forceChatCompletions && isOpenAIResponsesModel(model, endpoint)) {
        return callOpenAIResponsesStream(options);
    }

    let cleanBase = (endpoint || 'https://api.openai.com').trim().replace(/\/+$/, '');
    cleanBase = cleanBase.replace(/\/+(v1(\/(chat\/completions|models))?)?$/, '');
    const targetUrl = `${cleanBase}/v1/chat/completions`;

    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === 'https:' ? https : http;

    const payload = {
        model,
        messages,
        stream: true
    };
    if (tools && tools.length > 0) payload.tools = tools;

    const body = JSON.stringify(payload);
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    return new Promise((resolve, reject) => {
        const req = transport.request(parsed, { method: 'POST', headers, timeout: 60000 }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                let errBody = '';
                res.on('data', chunk => errBody += chunk);
                res.on('end', () => {
                    // Fall back to /v1/responses if chat completions indicates Responses API is required
                    if (res.statusCode === 400 && errBody.includes('/v1/responses')) {
                        if (model) RESPONSES_API_MODELS.add(model.toLowerCase());
                        return resolve(callOpenAIResponsesStream(options));
                    }
                    reject(new Error(`OpenAI error (${res.statusCode}): ${errBody}`));
                });
                return;
            }

            let buffer = '';
            let hasCompleted = false;
            const pendingToolCalls = {}; // index -> { id, name, args }

            res.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data:')) continue;

                    const dataStr = trimmed.slice(5).trim();
                    if (dataStr === '[DONE]') {
                        // Flush any pending tool calls
                        for (const idx of Object.keys(pendingToolCalls)) {
                            const tc = pendingToolCalls[idx];
                            onEvent({
                                type: 'tool_call',
                                id: tc.id,
                                name: tc.name,
                                arguments: tc.args
                            });
                        }
                        if (!hasCompleted) {
                            hasCompleted = true;
                            onEvent({ type: 'done' });
                        }
                        continue;
                    }

                    try {
                        const data = JSON.parse(dataStr);
                        const choice = data.choices?.[0];
                        if (!choice) continue;

                        const delta = choice.delta || {};
                        const thoughtText = delta.reasoning_content || delta.reasoning;
                        if (thoughtText) {
                            onEvent({ type: 'thought', text: thoughtText });
                        }
                        if (delta.content) {
                            onEvent({ type: 'text', text: delta.content });
                        }
                        if (Array.isArray(delta.tool_calls)) {
                            for (const tc of delta.tool_calls) {
                                const idx = tc.index || 0;
                                if (!pendingToolCalls[idx]) {
                                    pendingToolCalls[idx] = { id: tc.id || '', name: '', args: '' };
                                }
                                if (tc.id) pendingToolCalls[idx].id = tc.id;
                                if (tc.function?.name) pendingToolCalls[idx].name += tc.function.name;
                                if (tc.function?.arguments) pendingToolCalls[idx].args += tc.function.arguments;
                            }
                        }

                        if (choice.finish_reason) {
                            for (const idx of Object.keys(pendingToolCalls)) {
                                const tc = pendingToolCalls[idx];
                                onEvent({
                                    type: 'tool_call',
                                    id: tc.id,
                                    name: tc.name,
                                    arguments: tc.args
                                });
                                delete pendingToolCalls[idx];
                            }
                            if (!hasCompleted) {
                                hasCompleted = true;
                                onEvent({ type: 'done', finishReason: choice.finish_reason });
                            }
                        }
                    } catch (e) {}
                }
            });

            res.on('end', () => resolve());
            res.on('error', reject);
        });

        req.on('timeout', () => {
            req.destroy(new Error('OpenAI request timed out after 60 seconds'));
        });
        req.on('error', reject);

        if (options.signal) {
            if (options.signal.aborted) {
                req.destroy(new Error('Aborted by client'));
            } else {
                options.signal.addEventListener('abort', () => {
                    req.destroy(new Error('Aborted by client'));
                });
            }
        }

        req.write(body);
        req.end();
    });
}

/**
 * Normalizes JSON schema types from uppercase (e.g. OBJECT, STRING) to lowercase standard JSON schema.
 * Ensures the root schema has type: 'object' and properties: {}, while preserving nested schemas without
 * corrupting properties dictionaries.
 */
function normalizeJsonSchema(schema, isRoot = true) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        return isRoot ? { type: 'object', properties: {} } : schema;
    }

    const out = {};

    for (const [key, value] of Object.entries(schema)) {
        if (key === 'type') {
            if (typeof value === 'string') {
                out.type = value.toLowerCase();
            } else if (Array.isArray(value)) {
                out.type = value.map(t => typeof t === 'string' ? t.toLowerCase() : t);
            } else {
                out.type = value;
            }
        } else if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
            out.properties = {};
            for (const [propName, propSchema] of Object.entries(value)) {
                out.properties[propName] = normalizeJsonSchema(propSchema, false);
            }
        } else if (key === 'patternProperties' && value && typeof value === 'object' && !Array.isArray(value)) {
            out.patternProperties = {};
            for (const [pat, propSchema] of Object.entries(value)) {
                out.patternProperties[pat] = normalizeJsonSchema(propSchema, false);
            }
        } else if ((key === '$defs' || key === 'definitions') && value && typeof value === 'object' && !Array.isArray(value)) {
            out[key] = {};
            for (const [defName, defSchema] of Object.entries(value)) {
                out[key][defName] = normalizeJsonSchema(defSchema, false);
            }
        } else if (key === 'items') {
            if (Array.isArray(value)) {
                out.items = value.map(item => normalizeJsonSchema(item, false));
            } else if (value && typeof value === 'object') {
                out.items = normalizeJsonSchema(value, false);
            } else {
                out.items = value;
            }
        } else if (key === 'prefixItems' && Array.isArray(value)) {
            out.prefixItems = value.map(item => normalizeJsonSchema(item, false));
        } else if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
            out[key] = value.map(item => normalizeJsonSchema(item, false));
        } else if (key === 'additionalProperties' && value && typeof value === 'object' && !Array.isArray(value)) {
            out.additionalProperties = normalizeJsonSchema(value, false);
        } else if (key === 'required' && Array.isArray(value)) {
            out.required = value.filter(r => typeof r === 'string');
        } else {
            out[key] = value;
        }
    }

    if (isRoot) {
        if (!out.type) {
            out.type = 'object';
        }
        if (!out.properties && out.type === 'object') {
            out.properties = {};
        }
    }

    return out;
}

/**
 * Converts Gemini tool declarations to Anthropic tools array.
 */
function geminiToolsToAnthropic(tools) {
    if (!Array.isArray(tools)) return undefined;
    const anthropicTools = [];
    for (const toolGroup of tools) {
        if (Array.isArray(toolGroup.functionDeclarations)) {
            for (const fn of toolGroup.functionDeclarations) {
                if (!fn || !fn.name) continue;
                anthropicTools.push({
                    name: fn.name,
                    description: fn.description || '',
                    input_schema: normalizeJsonSchema(fn.parameters || { type: 'object', properties: {} })
                });
            }
        }
    }
    return anthropicTools.length > 0 ? anthropicTools : undefined;
}

/**
 * Converts Gemini tool declarations to OpenAI tools array.
 */
function geminiToolsToOpenAI(tools) {
    if (!Array.isArray(tools)) return undefined;
    const openAiTools = [];
    for (const toolGroup of tools) {
        if (Array.isArray(toolGroup.functionDeclarations)) {
            for (const fn of toolGroup.functionDeclarations) {
                if (!fn || !fn.name) continue;
                openAiTools.push({
                    type: 'function',
                    function: {
                        name: fn.name,
                        description: fn.description || '',
                        parameters: normalizeJsonSchema(fn.parameters || { type: 'object', properties: {} })
                    }
                });
            }
        }
    }
    return openAiTools.length > 0 ? openAiTools : undefined;
}

/**
 * Ensures Anthropic message sequence starts with 'user' and alternates strictly.
 */
function coalesceAnthropicMessages(rawMessages) {
    if (!rawMessages || rawMessages.length === 0) {
        return [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }];
    }
    const coalesced = [];
    for (const msg of rawMessages) {
        if (coalesced.length === 0) {
            if (msg.role !== 'user') {
                coalesced.push({ role: 'user', content: [{ type: 'text', text: 'Proceed.' }] });
            }
            coalesced.push({
                role: msg.role,
                content: Array.isArray(msg.content) ? [...msg.content] : [{ type: 'text', text: String(msg.content) }]
            });
            continue;
        }
        const prev = coalesced[coalesced.length - 1];
        if (prev.role === msg.role) {
            const extra = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content) }];
            prev.content.push(...extra);
        } else {
            coalesced.push({
                role: msg.role,
                content: Array.isArray(msg.content) ? [...msg.content] : [{ type: 'text', text: String(msg.content) }]
            });
        }
    }
    return coalesced;
}

/**
 * Converts Gemini contents and systemInstruction into Anthropic Messages format.
 */
function geminiContentsToAnthropic(contents, systemInstruction) {
    let system = '';
    if (systemInstruction) {
        if (typeof systemInstruction === 'string') {
            system = systemInstruction;
        } else if (Array.isArray(systemInstruction.parts)) {
            system = systemInstruction.parts.map(p => p.text || '').join('\n');
        }
    }

    const rawMessages = [];
    const toolCallIdsByName = {};

    if (Array.isArray(contents)) {
        for (const item of contents) {
            const role = item.role === 'model' ? 'assistant' : 'user';
            const blocks = [];

            if (Array.isArray(item.parts)) {
                for (const part of item.parts) {
                    if (part.text && !part.thought) {
                        blocks.push({ type: 'text', text: part.text });
                    }
                    if (part.functionCall) {
                        const callId = part.functionCall.id || `toolu_${crypto.randomUUID().slice(0, 8)}`;
                        if (!toolCallIdsByName[part.functionCall.name]) {
                            toolCallIdsByName[part.functionCall.name] = [];
                        }
                        toolCallIdsByName[part.functionCall.name].push(callId);
                        blocks.push({
                            type: 'tool_use',
                            id: callId,
                            name: part.functionCall.name,
                            input: part.functionCall.args || {}
                        });
                    }
                    if (part.functionResponse) {
                        const queue = toolCallIdsByName[part.functionResponse.name];
                        const callId = part.functionResponse.id || (queue && queue.length > 0 ? queue.shift() : null) || 'toolu_unknown';
                        let contentStr = '';
                        if (typeof part.functionResponse.response === 'string') {
                            contentStr = part.functionResponse.response;
                        } else {
                            contentStr = JSON.stringify(part.functionResponse.response || {});
                        }
                        rawMessages.push({
                            role: 'user',
                            content: [{
                                type: 'tool_result',
                                tool_use_id: callId,
                                content: contentStr
                            }]
                        });
                    }
                    if (part.inlineData) {
                        blocks.push({
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: part.inlineData.mimeType || 'image/jpeg',
                                data: part.inlineData.data
                            }
                        });
                    }
                }
            }

            if (blocks.length > 0) {
                rawMessages.push({ role, content: blocks });
            }
        }
    }

    const messages = coalesceAnthropicMessages(rawMessages);
    return { system: system.trim() || undefined, messages };
}

/**
 * Converts Gemini contents and systemInstruction into OpenAI chat completion messages array.
 */
function geminiContentsToOpenAI(contents, systemInstruction) {
    const messages = [];
    if (systemInstruction) {
        let sysText = '';
        if (typeof systemInstruction === 'string') {
            sysText = systemInstruction;
        } else if (Array.isArray(systemInstruction.parts)) {
            sysText = systemInstruction.parts.map(p => p.text || '').join('\n');
        }
        if (sysText.trim()) {
            messages.push({ role: 'system', content: sysText.trim() });
        }
    }

    const toolCallIdsByName = {};

    if (Array.isArray(contents)) {
        for (const item of contents) {
            if (item.role === 'model') {
                const textParts = [];
                const toolCalls = [];

                if (Array.isArray(item.parts)) {
                    for (const part of item.parts) {
                        if (part.text && !part.thought) {
                            textParts.push(part.text);
                        }
                        if (part.functionCall) {
                            const callId = part.functionCall.id || `call_${crypto.randomUUID().slice(0, 8)}`;
                            if (!toolCallIdsByName[part.functionCall.name]) {
                                toolCallIdsByName[part.functionCall.name] = [];
                            }
                            toolCallIdsByName[part.functionCall.name].push(callId);
                            toolCalls.push({
                                id: callId,
                                type: 'function',
                                function: {
                                    name: part.functionCall.name,
                                    arguments: JSON.stringify(part.functionCall.args || {})
                                }
                            });
                        }
                    }
                }

                const msg = { role: 'assistant' };
                if (textParts.length > 0) msg.content = textParts.join('\n');
                if (toolCalls.length > 0) msg.tool_calls = toolCalls;
                if (msg.content || msg.tool_calls) {
                    messages.push(msg);
                }
            } else {
                if (Array.isArray(item.parts)) {
                    for (const part of item.parts) {
                        if (part.functionResponse) {
                            const queue = toolCallIdsByName[part.functionResponse.name];
                            const callId = part.functionResponse.id || (queue && queue.length > 0 ? queue.shift() : null) || 'call_unknown';
                            messages.push({
                                role: 'tool',
                                tool_call_id: callId,
                                content: typeof part.functionResponse.response === 'string'
                                    ? part.functionResponse.response
                                    : JSON.stringify(part.functionResponse.response || {})
                            });
                        } else if (part.text) {
                            messages.push({ role: 'user', content: part.text });
                        } else if (part.inlineData) {
                            messages.push({
                                role: 'user',
                                content: [
                                    {
                                        type: 'image_url',
                                        image_url: {
                                            url: `data:${part.inlineData.mimeType || 'image/jpeg'};base64,${part.inlineData.data}`
                                        }
                                    }
                                ]
                            });
                        }
                    }
                }
            }
        }
    }

    if (messages.length === 0 || (messages.length === 1 && messages[0].role === 'system')) {
        messages.push({ role: 'user', content: 'Hello' });
    }

    return messages;
}

module.exports = {
    callAnthropicStream,
    callOpenAIStream,
    callOpenAIResponsesStream,
    isAdaptiveThinkingModel,
    isOpenAIResponsesModel,
    chatMessagesToResponsesInput,
    chatToolsToResponsesTools,
    normalizeJsonSchema,
    geminiToolsToAnthropic,
    geminiToolsToOpenAI,
    coalesceAnthropicMessages,
    geminiContentsToAnthropic,
    geminiContentsToOpenAI
};
