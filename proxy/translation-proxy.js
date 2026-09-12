#!/usr/bin/env bun
'use strict';

const http = require('node:http');
const https = require('node:https');
const {
    callAnthropicStream,
    callOpenAIStream,
    geminiContentsToAnthropic,
    geminiToolsToAnthropic,
    geminiContentsToOpenAI,
    geminiToolsToOpenAI
} = require('./lib/transcoder.js');
const { CUSTOM_PLACEHOLDER_REGEX } = require('./lib/models-manager.js');

const DEFAULT_PORT = parseInt(process.env.TRANSLATION_PORT || '4405', 10);
const DEFAULT_UPSTREAM = process.env.CLOUDCODE_UPSTREAM_URL || 'https://cloudcode-pa.googleapis.com';

const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'transfer-encoding',
    'upgrade'
]);

function filterHeaders(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && !key.startsWith(':')) {
            out[key] = value;
        }
    }
    return out;
}

function isStreamGenerateContent(url) {
    if (!url) return false;
    return url.includes(':streamGenerateContent') || url.includes('/streamGenerateContent');
}

function normalizeFinishReason(reason) {
    if (!reason) return 'STOP';
    const lower = String(reason).toLowerCase();
    if (lower === 'stop' || lower === 'end_turn' || lower === 'tool_use' || lower === 'tool_calls') {
        return 'STOP';
    }
    if (lower === 'length' || lower === 'max_tokens') {
        return 'MAX_TOKENS';
    }
    return String(reason).toUpperCase();
}

class TranslationProxy {
    constructor(options = {}) {
        this.port = options.port || DEFAULT_PORT;
        this.upstreamUrl = options.upstreamUrl || DEFAULT_UPSTREAM;
        this.modelsManager = options.modelsManager || null;
        this.activeConversationModels = options.activeConversationModels || new Map();
        this.server = null;
        this.isRunning = false;
    }

    start() {
        return new Promise((resolve, reject) => {
            if (this.isRunning) return resolve(this.server);

            this.server = http.createServer((req, res) => {
                this.handleRequest(req, res);
            });

            this.server.on('error', (err) => {
                console.error('[Translation Proxy] Server error:', err.message);
                if (!this.isRunning) reject(err);
            });

            this.server.listen(this.port, '127.0.0.1', () => {
                this.isRunning = true;
                console.log(`[Translation Proxy] 🚀 Listening on 127.0.0.1:${this.port} (Upstream: ${this.upstreamUrl})`);
                resolve(this.server);
            });
        });
    }

    stop() {
        return new Promise((resolve) => {
            if (!this.server || !this.isRunning) return resolve();
            this.server.close(() => {
                this.isRunning = false;
                console.log('[Translation Proxy] ⏹️  Stopped');
                resolve();
            });
        });
    }

    handleRequest(req, res) {
        const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

        // Health check endpoint
        if (parsedUrl.pathname === '/__proxy/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                port: this.port,
                upstream: this.upstreamUrl,
                timestamp: new Date().toISOString()
            }));
            return;
        }

        // Intercept Gemini streamGenerateContent requests
        if (isStreamGenerateContent(parsedUrl.pathname) && req.method === 'POST') {
            this.handleStreamGenerateContent(req, res);
            return;
        }

        // Standard pass-through reverse proxy
        this.forwardPassThrough(req, res);
    }

    resolveCustomModel(parsedData) {
        if (!this.activeConversationModels || this.activeConversationModels.size === 0) {
            return null;
        }

        const cascadeId = parsedData?.cascadeId || parsedData?.request?.cascadeId;
        if (cascadeId && this.activeConversationModels.has(cascadeId)) {
            return this.activeConversationModels.get(cascadeId);
        }

        const convoId = parsedData?.conversationId || parsedData?.request?.conversationId || parsedData?.request?.sessionId;
        if (convoId && this.activeConversationModels.has(convoId)) {
            return this.activeConversationModels.get(convoId);
        }

        // Guard: If request explicitly targets a standard model that is NOT aliased, pass through
        const modelStr = parsedData?.model || parsedData?.request?.model;
        if (typeof modelStr === 'string' && modelStr.length > 0) {
            if (!modelStr.includes('M318') && !CUSTOM_PLACEHOLDER_REGEX.test(modelStr)) {
                return null;
            }
        }

        if (this.activeConversationModels.has('latest')) {
            return this.activeConversationModels.get('latest');
        }

        return null;
    }

    handleStreamGenerateContent(req, res) {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('error', (err) => {
            console.error('[Translation Proxy] Request error:', err.message);
            if (!res.headersSent && !res.writableEnded) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        req.on('end', async () => {
            const rawBody = Buffer.concat(chunks);
            let parsedData = null;
            try {
                parsedData = JSON.parse(rawBody.toString('utf8'));
            } catch (e) {}

            const customModel = this.resolveCustomModel(parsedData);
            if (!customModel) {
                // Pass through directly to upstream Google CloudCode
                this.forwardPassThrough(req, res, rawBody);
                return;
            }

            try {
                await this.translateAndStream(parsedData, customModel, res);
            } catch (err) {
                console.error('[Translation Proxy] Translation error:', err.message);
                if (!res.headersSent) {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive'
                    });
                }
                const errorText = `\n\n**Error connecting to custom model provider (${customModel.providerType}):**\n\`\`\`\n${err.message}\n\`\`\`\nPlease check your provider configuration in \`/models\`.`;
                const errChunk = {
                    response: {
                        candidates: [{
                            content: {
                                role: 'model',
                                parts: [{ text: errorText }]
                            },
                            finishReason: 'STOP'
                        }]
                    }
                };
                res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
                res.end();
            }
        });
    }

    async translateAndStream(parsedData, customModel, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        const abortController = new AbortController();
        const onClose = () => {
            abortController.abort();
        };
        res.on('close', onClose);

        const requestObj = parsedData.request || parsedData;
        const contents = requestObj.contents || [];
        const systemInstruction = requestObj.systemInstruction;
        const tools = requestObj.tools;
        const generationConfig = requestObj.generationConfig || {};
        const maxTokens = generationConfig.maxOutputTokens || 4096;

        const onEvent = (ev) => {
            if (res.writableEnded || res.destroyed) return;

            if (ev.type === 'thought') {
                const chunk = {
                    response: {
                        candidates: [{
                            content: {
                                role: 'model',
                                parts: [{ text: ev.text, thought: true }]
                            }
                        }]
                    }
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            } else if (ev.type === 'text') {
                const chunk = {
                    response: {
                        candidates: [{
                            content: {
                                role: 'model',
                                parts: [{ text: ev.text }]
                            }
                        }]
                    }
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            } else if (ev.type === 'tool_call') {
                let argsObj = {};
                try {
                    argsObj = typeof ev.arguments === 'string' ? JSON.parse(ev.arguments) : (ev.arguments || {});
                } catch (e) {
                    argsObj = { raw: ev.arguments };
                }
                const fnCall = { name: ev.name, args: argsObj };
                if (ev.id) fnCall.id = ev.id;
                const chunk = {
                    response: {
                        candidates: [{
                            content: {
                                role: 'model',
                                parts: [{ functionCall: fnCall }]
                            }
                        }]
                    }
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            } else if (ev.type === 'done') {
                const finishReason = normalizeFinishReason(ev.finishReason || ev.stopReason);
                const chunk = {
                    response: {
                        candidates: [{
                            content: {
                                role: 'model',
                                parts: []
                            },
                            finishReason
                        }]
                    }
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
        };

        try {
            if (customModel.providerType === 'anthropic') {
                const { system, messages } = geminiContentsToAnthropic(contents, systemInstruction);
                const anthropicTools = geminiToolsToAnthropic(tools);

                await callAnthropicStream({
                    endpoint: customModel.endpoint,
                    apiKey: customModel.apiKey,
                    model: customModel.rawModelId,
                    messages,
                    system,
                    tools: anthropicTools,
                    supportsThinking: Boolean(customModel.supportsThinking),
                    maxTokens,
                    signal: abortController.signal,
                    onEvent
                });
            } else {
                // OpenAI or Ollama-compatible
                const messages = geminiContentsToOpenAI(contents, systemInstruction);
                const openAiTools = geminiToolsToOpenAI(tools);

                await callOpenAIStream({
                    endpoint: customModel.endpoint,
                    apiKey: customModel.apiKey,
                    model: customModel.rawModelId,
                    messages,
                    tools: openAiTools,
                    signal: abortController.signal,
                    onEvent
                });
            }
        } finally {
            res.removeListener('close', onClose);
        }

        if (!res.writableEnded && !res.destroyed) {
            res.end();
        }
    }

    forwardPassThrough(req, res, rawBodyBuffer = null) {
        const targetUrl = new URL(req.url, this.upstreamUrl);
        const isHttps = targetUrl.protocol === 'https:';
        const client = isHttps ? https : http;

        const headers = filterHeaders(req.headers);
        headers['host'] = targetUrl.host;

        if (rawBodyBuffer) {
            headers['content-length'] = String(rawBodyBuffer.length);
        }

        const proxyReq = client.request(targetUrl, {
            method: req.method,
            headers,
            timeout: 60000
        }, (proxyRes) => {
            const resHeaders = filterHeaders(proxyRes.headers);
            res.writeHead(proxyRes.statusCode, resHeaders);
            proxyRes.pipe(res);
        });

        proxyReq.on('timeout', () => {
            proxyReq.destroy(new Error('Gateway timeout after 60000ms'));
        });

        res.on('close', () => {
            if (!res.writableEnded && !proxyReq.destroyed) {
                proxyReq.destroy();
            }
        });

        proxyReq.on('error', (err) => {
            console.error('[Translation Proxy] Upstream error:', err.message);
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Translation Proxy upstream error',
                    details: err.message
                }));
            } else {
                res.destroy();
            }
        });

        if (rawBodyBuffer) {
            proxyReq.write(rawBodyBuffer);
            proxyReq.end();
        } else {
            req.pipe(proxyReq, { end: true });
        }
    }
}

if (require.main === module) {
    const proxy = new TranslationProxy();
    proxy.start().catch((err) => {
        console.error('[Translation Proxy] Startup failed:', err);
        process.exit(1);
    });
}

module.exports = {
    TranslationProxy,
    DEFAULT_PORT,
    DEFAULT_UPSTREAM,
    isStreamGenerateContent
};
