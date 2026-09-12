'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

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

    const payload = {
        model,
        messages,
        max_tokens: maxTokens,
        stream: true
    };
    if (supportsThinking) {
        payload.thinking = { type: 'enabled', budget_tokens: 2048 };
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
                res.on('end', () => reject(new Error(`Anthropic error (${res.statusCode}): ${errBody}`)));
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

/**
 * Streams chat completion from an OpenAI-compatible endpoint and normalizes events.
 */
function callOpenAIStream(options) {
    const { endpoint, apiKey, model, messages, tools, onEvent } = options;

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
                res.on('end', () => reject(new Error(`OpenAI error (${res.statusCode}): ${errBody}`)));
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
 */
function normalizeJsonSchema(schema) {
    if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
    const out = Array.isArray(schema) ? [] : {};
    for (const [k, v] of Object.entries(schema)) {
        if (k === 'type' && typeof v === 'string') {
            out[k] = v.toLowerCase();
        } else if (typeof v === 'object' && v !== null) {
            out[k] = normalizeJsonSchema(v);
        } else {
            out[k] = v;
        }
    }
    if (!Array.isArray(out) && !out.type) {
        out.type = 'object';
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
    normalizeJsonSchema,
    geminiToolsToAnthropic,
    geminiToolsToOpenAI,
    coalesceAnthropicMessages,
    geminiContentsToAnthropic,
    geminiContentsToOpenAI
};
