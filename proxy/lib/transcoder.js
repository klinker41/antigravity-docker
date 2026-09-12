'use strict';

const http = require('node:http');
const https = require('node:https');

/**
 * Streams chat completion from an Anthropic Messages endpoint and normalizes events.
 */
function callAnthropicStream(options) {
    const { endpoint, apiKey, model, messages, system, tools, maxTokens = 4096, onEvent } = options;

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
        const req = transport.request(parsed, { method: 'POST', headers }, (res) => {
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

        req.on('error', reject);
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
        const req = transport.request(parsed, { method: 'POST', headers }, (res) => {
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
                        if (delta.reasoning_content) {
                            onEvent({ type: 'thought', text: delta.reasoning_content });
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

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

module.exports = {
    callAnthropicStream,
    callOpenAIStream
};
