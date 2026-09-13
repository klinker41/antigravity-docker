const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

const {
    TranslationProxy,
    isStreamGenerateContent,
    isGenerateContent,
    isFetchAvailableModels,
    injectAvailableModels
} = require('../proxy/translation-proxy');

test('Translation Proxy - Server Lifecycle & Transparent Pass-Through', async (t) => {
    // 1. Create a mock upstream representing Google CloudCode
    let upstreamReceived = null;
    const mockGoogleUpstream = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            upstreamReceived = {
                method: req.method,
                url: req.url,
                headers: req.headers,
                body
            };
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'X-Mock-Upstream': 'Google-CloudCode'
            });
            res.end(JSON.stringify({ status: 'ok', mock: true }));
        });
    });

    await new Promise((resolve) => mockGoogleUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = mockGoogleUpstream.address().port;

    // 2. Initialize TranslationProxy targeting mock upstream
    const proxyPort = upstreamPort + 10;
    const proxy = new TranslationProxy({
        port: proxyPort,
        upstreamUrl: `http://127.0.0.1:${upstreamPort}`
    });

    await proxy.start();

    t.after(async () => {
        await proxy.stop();
        mockGoogleUpstream.close();
    });

    await t.test('passes standard requests through to upstream transparently', async () => {
        const testPayload = JSON.stringify({ model: 'gemini-3.8-flash', prompt: 'test' });
        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: proxyPort,
                path: '/v1internal:loadCodeAssist',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer test-oauth-token',
                    'Content-Length': Buffer.byteLength(testPayload)
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: data
                }));
            });
            req.on('error', reject);
            req.write(testPayload);
            req.end();
        });

        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['x-mock-upstream'], 'Google-CloudCode');
        const parsed = JSON.parse(res.body);
        assert.equal(parsed.status, 'ok');

        // Verify upstream received identical request
        assert.ok(upstreamReceived);
        assert.equal(upstreamReceived.url, '/v1internal:loadCodeAssist');
        assert.equal(upstreamReceived.headers['authorization'], 'Bearer test-oauth-token');
        assert.equal(upstreamReceived.body, testPayload);
    });

    await t.test('health endpoint reports proxy status', async () => {
        const res = await new Promise((resolve, reject) => {
            const req = http.get(`http://127.0.0.1:${proxyPort}/__proxy/health`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
            });
            req.on('error', reject);
        });

        assert.equal(res.statusCode, 200);
        const parsed = JSON.parse(res.body);
        assert.equal(parsed.status, 'ok');
        assert.equal(parsed.port, proxyPort);
    });

    await t.test('intercepts streamGenerateContent and translates to Anthropic SSE with thoughts and tools', async () => {
        // Setup mock Anthropic server
        const mockAnthropic = http.createServer((req, res) => {
            assert.equal(req.headers['x-api-key'], 'ant-key-123');
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache'
            });

            // Thinking
            res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n');
            res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan: check files"}}\n\n');
            res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');

            // Text
            res.write('event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}\n\n');
            res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"I will list the directory."}}\n\n');
            res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n');

            // Tool call
            res.write('event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call_1","name":"run_command"}}\n\n');
            res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"CommandLine\\":\\"ls\\"}"}}\n\n');
            res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n');

            res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n');
            res.end();
        });

        await new Promise((resolve) => mockAnthropic.listen(0, '127.0.0.1', resolve));
        const antPort = mockAnthropic.address().port;

        // Register active model in proxy
        proxy.activeConversationModels.set('cascade-123', {
            providerType: 'anthropic',
            endpoint: `http://127.0.0.1:${antPort}`,
            apiKey: 'ant-key-123',
            rawModelId: 'claude-3-7-sonnet',
            supportsThinking: true
        });

        const geminiPayload = JSON.stringify({
            cascadeId: 'cascade-123',
            request: {
                contents: [{ role: 'user', parts: [{ text: 'List files' }] }],
                systemInstruction: { parts: [{ text: 'Assistant system prompt' }] },
                tools: [
                    {
                        functionDeclarations: [
                            {
                                name: 'run_command',
                                description: 'Run bash',
                                parameters: { type: 'OBJECT', properties: { CommandLine: { type: 'STRING' } } }
                            }
                        ]
                    }
                ]
            }
        });

        const sseEvents = [];
        await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: proxyPort,
                path: '/v1internal:streamGenerateContent?alt=sse',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(geminiPayload)
                }
            }, (res) => {
                assert.equal(res.statusCode, 200);
                assert.equal(res.headers['content-type'], 'text/event-stream');
                let buffer = '';
                res.on('data', chunk => {
                    buffer += chunk.toString('utf8');
                    const lines = buffer.split('\n');
                    buffer = lines.pop();
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('data:')) {
                            try {
                                sseEvents.push(JSON.parse(trimmed.slice(5).trim()));
                            } catch (e) {}
                        }
                    }
                });
                res.on('end', resolve);
            });
            req.on('error', reject);
            req.write(geminiPayload);
            req.end();
        });

        mockAnthropic.close();
        proxy.activeConversationModels.delete('cascade-123');

        assert.ok(sseEvents.length >= 3, 'Must receive at least thought, text, and tool_call chunks');

        // Verify thought chunk
        const thoughtChunk = sseEvents.find(e => e.response?.candidates?.[0]?.content?.parts?.[0]?.thought);
        assert.ok(thoughtChunk, 'Must contain thought chunk');
        assert.equal(thoughtChunk.response.candidates[0].content.parts[0].text, 'Plan: check files');

        // Verify text chunk
        const textChunk = sseEvents.find(e => e.response?.candidates?.[0]?.content?.parts?.[0]?.text === 'I will list the directory.');
        assert.ok(textChunk, 'Must contain text chunk');

        // Verify functionCall chunk
        const fnChunk = sseEvents.find(e => e.response?.candidates?.[0]?.content?.parts?.[0]?.functionCall);
        assert.ok(fnChunk, 'Must contain functionCall chunk');
        assert.equal(fnChunk.response.candidates[0].content.parts[0].functionCall.name, 'run_command');
        assert.deepEqual(fnChunk.response.candidates[0].content.parts[0].functionCall.args, { CommandLine: 'ls' });
    });

    await t.test('intercepts streamGenerateContent and translates to OpenAI SSE with thoughts and tools', async () => {
        const mockOpenAI = http.createServer((req, res) => {
            assert.equal(req.headers['authorization'], 'Bearer openai-key-456');
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache'
            });

            res.write('data: {"choices":[{"delta":{"reasoning_content":"Thinking deeply..."}}]}\n\n');
            res.write('data: {"choices":[{"delta":{"content":"Reading file."}}]}\n\n');
            res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_99","type":"function","function":{"name":"view_file","arguments":"{\\"AbsolutePath\\":\\"/a\\"}"}}]}}]}\n\n');
            res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
        });

        await new Promise((resolve) => mockOpenAI.listen(0, '127.0.0.1', resolve));
        const oaiPort = mockOpenAI.address().port;

        proxy.activeConversationModels.set('latest', {
            providerType: 'openai',
            endpoint: `http://127.0.0.1:${oaiPort}`,
            apiKey: 'openai-key-456',
            rawModelId: 'gpt-4o'
        });

        const geminiPayload = JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'View /a' }] }]
        });

        const sseEvents = [];
        await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: proxyPort,
                path: '/v1internal:streamGenerateContent?alt=sse',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(geminiPayload)
                }
            }, (res) => {
                assert.equal(res.statusCode, 200);
                let buffer = '';
                res.on('data', chunk => {
                    buffer += chunk.toString('utf8');
                    const lines = buffer.split('\n');
                    buffer = lines.pop();
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('data:')) {
                            try {
                                sseEvents.push(JSON.parse(trimmed.slice(5).trim()));
                            } catch (e) {}
                        }
                    }
                });
                res.on('end', resolve);
            });
            req.on('error', reject);
            req.write(geminiPayload);
            req.end();
        });

        mockOpenAI.close();
        proxy.activeConversationModels.delete('latest');

        const thoughtChunk = sseEvents.find(e => e.response?.candidates?.[0]?.content?.parts?.[0]?.thought);
        assert.ok(thoughtChunk);
        assert.equal(thoughtChunk.response.candidates[0].content.parts[0].text, 'Thinking deeply...');

        const textChunk = sseEvents.find(e => e.response?.candidates?.[0]?.content?.parts?.[0]?.text === 'Reading file.');
        assert.ok(textChunk);

        const fnChunk = sseEvents.find(e => e.response?.candidates?.[0]?.content?.parts?.[0]?.functionCall);
        assert.ok(fnChunk);
        assert.equal(fnChunk.response.candidates[0].content.parts[0].functionCall.name, 'view_file');
    });

    await t.test('emits user-facing markdown error when external model provider fails', async () => {
        proxy.activeConversationModels.set('latest', {
            providerType: 'openai',
            endpoint: 'http://127.0.0.1:59999', // Non-existent port
            apiKey: 'bad-key',
            rawModelId: 'gpt-4o'
        });

        const geminiPayload = JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Hello' }] }]
        });

        const sseEvents = [];
        await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: proxyPort,
                path: '/v1internal:streamGenerateContent?alt=sse',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(geminiPayload)
                }
            }, (res) => {
                assert.equal(res.statusCode, 200);
                assert.equal(res.headers['content-type'], 'text/event-stream');
                let buffer = '';
                res.on('data', chunk => {
                    buffer += chunk.toString('utf8');
                    const lines = buffer.split('\n');
                    buffer = lines.pop();
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('data:')) {
                            try {
                                sseEvents.push(JSON.parse(trimmed.slice(5).trim()));
                            } catch (e) {}
                        }
                    }
                });
                res.on('end', resolve);
            });
            req.on('error', reject);
            req.write(geminiPayload);
            req.end();
        });

        proxy.activeConversationModels.delete('latest');

        assert.ok(sseEvents.length > 0);
        const errText = sseEvents[0].response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        assert.ok(errText.includes('Error connecting to custom model provider'), 'Error message must be formatted in markdown');
        assert.ok(errText.includes('/models'));
    });

    await t.test('resolveCustomModel returns null for standard Gemini models even when latest is populated', () => {
        proxy.activeConversationModels.set('latest', {
            providerType: 'openai',
            endpoint: 'http://127.0.0.1:1234',
            apiKey: 'key',
            rawModelId: 'gpt-4o'
        });

        // Explicit standard model must pass through directly
        const resolvedStandard = proxy.resolveCustomModel({
            request: { model: 'gemini-2.5-pro' }
        });
        assert.equal(resolvedStandard, null, 'Standard Gemini models must not be intercepted');

        // Standard Gemini 3.8 Flash (M318) must also pass through directly
        const resolvedM318 = proxy.resolveCustomModel({
            request: { model: 'MODEL_PLACEHOLDER_M318' }
        });
        assert.equal(resolvedM318, null, 'Standard Gemini 3.8 Flash (M318) must not be intercepted');

        // Custom placeholder without direct modelsManager registration should resolve to latest
        const resolvedCustom = proxy.resolveCustomModel({
            request: { model: 'MODEL_PLACEHOLDER_M500' }
        });
        assert.ok(resolvedCustom, 'Custom placeholder should resolve to latest custom model');

        proxy.activeConversationModels.delete('latest');
    });
});

test('Translation Proxy - isFetchAvailableModels and injectAvailableModels helpers', (t) => {
    assert.equal(isFetchAvailableModels('/v1internal:fetchAvailableModels'), true);
    assert.equal(isFetchAvailableModels('/v1internal/fetchAvailableModels'), true);
    assert.equal(isFetchAvailableModels('/v1internal:streamGenerateContent'), false);
    assert.equal(isFetchAvailableModels(null), false);
    assert.equal(isFetchAvailableModels(''), false);

    // Mock modelsManager
    const mockModelsManager = {
        getInjectedModels() {
            return [
                {
                    label: 'Claude Fable 5.1',
                    modelOrAlias: { model: 'MODEL_PLACEHOLDER_M592' },
                    supportsImages: true,
                    supportsThinking: true
                }
            ];
        }
    };

    const upstreamData = {
        models: {
            MODEL_PLACEHOLDER_M0: { displayName: 'Gemini 3.8 Flash' }
        },
        agentModelSorts: [
            {
                groups: [
                    { modelIds: ['MODEL_PLACEHOLDER_M0'] }
                ]
            }
        ]
    };

    const result = injectAvailableModels(upstreamData, mockModelsManager);
    assert.ok(result.models.MODEL_PLACEHOLDER_M592);
    assert.equal(result.models.MODEL_PLACEHOLDER_M592.displayName, 'Claude Fable 5.1');
    assert.equal(result.models.MODEL_PLACEHOLDER_M592.supportsThinking, true);
    assert.equal(result.models.MODEL_PLACEHOLDER_M592.supportsImages, true);
    assert.ok(result.agentModelSorts[0].groups[0].modelIds.includes('MODEL_PLACEHOLDER_M592'));
    assert.ok(result.agentModelSorts[0].groups[0].modelIds.includes('MODEL_PLACEHOLDER_M0'));

    // Handles missing or empty agentModelSorts gracefully
    const missingSorts = injectAvailableModels({ models: {} }, mockModelsManager);
    assert.ok(missingSorts.agentModelSorts[0].groups[0].modelIds.includes('MODEL_PLACEHOLDER_M592'));

    // Safe handling of null/empty inputs
    assert.deepEqual(injectAvailableModels(null, mockModelsManager), null);
    assert.deepEqual(injectAvailableModels({}, null), {});
    assert.deepEqual(injectAvailableModels({ foo: 1 }, { getInjectedModels: () => [] }), { foo: 1 });
});

test('Translation Proxy - fetchAvailableModels HTTP Interception and Placeholder Resolution', async (t) => {
    let upstreamCalled = false;
    let upstreamHeaders = null;
    const mockGoogleUpstream = http.createServer((req, res) => {
        if (req.url.includes('fetchAvailableModels')) {
            upstreamCalled = true;
            upstreamHeaders = req.headers;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                models: {
                    MODEL_PLACEHOLDER_M0: { displayName: 'Gemini 3.8 Flash' }
                },
                agentModelSorts: [
                    {
                        groups: [
                            { modelIds: ['MODEL_PLACEHOLDER_M0'] }
                        ]
                    }
                ]
            }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise((resolve) => mockGoogleUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = mockGoogleUpstream.address().port;
    const proxyPort = upstreamPort + 10;

    const mockModelsManager = {
        getInjectedModels() {
            return [
                {
                    label: 'Fable 5.1',
                    modelOrAlias: { model: 'MODEL_PLACEHOLDER_M592' },
                    supportsImages: true,
                    supportsThinking: true
                }
            ];
        },
        getModelByPlaceholder(placeholder) {
            if (placeholder === 'MODEL_PLACEHOLDER_M592') {
                return {
                    label: 'Fable 5.1',
                    modelId: 'custom-anthropic-claude-fable-5-1',
                    placeholder: 'MODEL_PLACEHOLDER_M592',
                    providerType: 'anthropic',
                    endpoint: 'https://api.anthropic.com',
                    apiKey: 'test-key',
                    rawModelId: 'claude-fable-5-1',
                    supportsThinking: true
                };
            }
            return null;
        }
    };

    const proxy = new TranslationProxy({
        port: proxyPort,
        upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
        modelsManager: mockModelsManager
    });

    await proxy.start();

    t.after(async () => {
        await proxy.stop();
        mockGoogleUpstream.close();
    });

    await t.test('intercepts fetchAvailableModels and merges custom models', async () => {
        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: proxyPort,
                path: '/v1internal:fetchAvailableModels',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer test-token'
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: data
                }));
            });
            req.on('error', reject);
            req.write(JSON.stringify({}));
            req.end();
        });

        assert.equal(res.statusCode, 200);
        assert.ok(upstreamCalled, 'Upstream must be called');
        assert.equal(upstreamHeaders['accept-encoding'], 'identity', 'Must request uncompressed upstream response');
        const parsed = JSON.parse(res.body);
        assert.ok(parsed.models.MODEL_PLACEHOLDER_M0, 'Upstream standard models must be preserved');
        assert.ok(parsed.models.MODEL_PLACEHOLDER_M592, 'Custom model must be injected');
        assert.equal(parsed.models.MODEL_PLACEHOLDER_M592.displayName, 'Fable 5.1');
        assert.equal(parsed.models.MODEL_PLACEHOLDER_M592.supportsThinking, true);
        assert.ok(parsed.agentModelSorts[0].groups[0].modelIds.includes('MODEL_PLACEHOLDER_M592'));
    });

    await t.test('resolveCustomModel resolves placeholder directly from modelsManager without session mapping', () => {
        const resolved = proxy.resolveCustomModel({
            request: { model: 'MODEL_PLACEHOLDER_M592' }
        });
        assert.ok(resolved, 'Must resolve custom model directly from modelsManager');
        assert.equal(resolved.rawModelId, 'claude-fable-5-1');
        assert.equal(resolved.providerType, 'anthropic');
    });

    await t.test('resolveCustomModel returns null for unknown placeholder or standard model', () => {
        const resolvedUnknown = proxy.resolveCustomModel({
            request: { model: 'MODEL_PLACEHOLDER_M600' }
        });
        assert.equal(resolvedUnknown, null);

        const resolvedStandard = proxy.resolveCustomModel({
            request: { model: 'MODEL_PLACEHOLDER_M0' }
        });
        assert.equal(resolvedStandard, null);
    });
});

test('Translation Proxy - generateContent Unary Interception & Search Web Support', async (t) => {
    await t.test('isGenerateContent accurately distinguishes unary from streaming endpoints', () => {
        assert.equal(isGenerateContent('/v1internal:generateContent'), true);
        assert.equal(isGenerateContent('/v1beta/models/gemini-2.5-flash:generateContent'), true);
        assert.equal(isGenerateContent('/generateContent'), true);
        assert.equal(isGenerateContent('/v1internal:streamGenerateContent'), false);
        assert.equal(isGenerateContent('/v1internal:streamGenerateContent?alt=sse'), false);
        assert.equal(isGenerateContent('/v1internal:fetchAvailableModels'), false);
        assert.equal(isGenerateContent(null), false);
        assert.equal(isGenerateContent(''), false);
    });

    // 1. Mock upstream (Google CloudCode)
    let upstreamCalled = false;
    const mockGoogleUpstream = http.createServer((req, res) => {
        upstreamCalled = true;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                candidates: [{
                    content: { role: 'model', parts: [{ text: 'Upstream response' }] },
                    finishReason: 'STOP'
                }]
            }));
        });
    });

    await new Promise((resolve) => mockGoogleUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = mockGoogleUpstream.address().port;

    // 2. Mock Custom Model Provider (OpenAI Responses API compatible)
    let providerCalled = false;
    const mockOpenAIProvider = http.createServer((req, res) => {
        providerCalled = true;
        assert.equal(req.headers['authorization'], 'Bearer astra-key');
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache'
        });
        res.write('data: {"type":"response.output_text.delta","delta":"Summary: Gemma 4 vision model is ready."}\n\n');
        res.write('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
    });

    await new Promise((resolve) => mockOpenAIProvider.listen(0, '127.0.0.1', resolve));
    const providerPort = mockOpenAIProvider.address().port;

    const proxyPort = upstreamPort + 20;
    const proxy = new TranslationProxy({
        port: proxyPort,
        upstreamUrl: `http://127.0.0.1:${upstreamPort}`
    });

    proxy.activeConversationModels.set('latest', {
        providerType: 'openai',
        endpoint: `http://127.0.0.1:${providerPort}`,
        apiKey: 'astra-key',
        rawModelId: 'gpt-6-astra',
        supportsThinking: false
    });

    await proxy.start();

    t.after(async () => {
        await proxy.stop();
        mockGoogleUpstream.close();
        mockOpenAIProvider.close();
    });

    await t.test('intercepts unary /v1internal:generateContent and returns valid GenerateContentResponse', async () => {
        const payload = JSON.stringify({
            model: 'MODEL_PLACEHOLDER_M500',
            contents: [{ role: 'user', parts: [{ text: 'Summarize web search results' }] }]
        });

        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: proxyPort,
                path: '/v1internal:generateContent',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: data
                }));
            });
            req.on('error', reject);
            req.write(payload);
            req.end();
        });

        assert.equal(res.statusCode, 200);
        assert.ok(providerCalled, 'Provider must be called for custom model unary generation');
        const parsed = JSON.parse(res.body);
        assert.ok(Array.isArray(parsed.candidates), 'Response must have top-level candidates');
        assert.equal(parsed.candidates.length, 1);
        assert.equal(parsed.candidates[0].content.parts[0].text, 'Summary: Gemma 4 vision model is ready.');
        assert.equal(parsed.candidates[0].finishReason, 'STOP');

        // Also check wrapped response.candidates for Go protojson compatibility
        assert.ok(parsed.response?.candidates, 'Response must have response.candidates');
        assert.equal(parsed.response.candidates[0].content.parts[0].text, 'Summary: Gemma 4 vision model is ready.');
    });

    await t.test('passes unary /v1internal:generateContent through to upstream for non-custom standard model', async () => {
        upstreamCalled = false;
        const payload = JSON.stringify({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [{ text: 'Test standard' }] }]
        });

        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: proxyPort,
                path: '/v1internal:generateContent',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: data
                }));
            });
            req.on('error', reject);
            req.write(payload);
            req.end();
        });

        assert.equal(res.statusCode, 200);
        assert.ok(upstreamCalled, 'Upstream must be called for non-custom model');
        const parsed = JSON.parse(res.body);
        assert.equal(parsed.candidates[0].content.parts[0].text, 'Upstream response');
    });
});

test('Translation Proxy - resolveCustomModel does not misroute built-in placeholder to custom model', () => {
    const mockModelsManager = {
        getModelByPlaceholder(placeholder) {
            // Only M592 is a registered custom model
            if (placeholder === 'MODEL_PLACEHOLDER_M592') {
                return {
                    label: 'Custom Claude',
                    providerType: 'anthropic',
                    endpoint: 'https://api.anthropic.com',
                    apiKey: 'key',
                    rawModelId: 'claude-custom',
                    supportsThinking: false
                };
            }
            return null;
        }
    };

    const proxy = new TranslationProxy({
        port: 19999,
        upstreamUrl: 'http://127.0.0.1:19998',
        modelsManager: mockModelsManager
    });

    // Populate latest with a custom model — simulates an active custom model session
    proxy.activeConversationModels.set('latest', {
        providerType: 'openai',
        endpoint: 'http://127.0.0.1:12345',
        apiKey: 'key',
        rawModelId: 'gpt-6'
    });

    // Built-in placeholder M599 in custom range must NOT resolve to the custom model
    const builtInResult = proxy.resolveCustomModel({
        request: { model: 'MODEL_PLACEHOLDER_M599' }
    });
    assert.equal(builtInResult, null, 'Built-in M599 must pass through to Google, not custom model');

    // Built-in placeholder M605 must also pass through
    const builtInResult2 = proxy.resolveCustomModel({
        request: { model: 'MODEL_PLACEHOLDER_M605' }
    });
    assert.equal(builtInResult2, null, 'Built-in M605 must pass through to Google, not custom model');

    // Registered custom placeholder M592 MUST still resolve to the custom model
    const customResult = proxy.resolveCustomModel({
        request: { model: 'MODEL_PLACEHOLDER_M592' }
    });
    assert.ok(customResult, 'Registered custom M592 must resolve to custom model');
    assert.equal(customResult.rawModelId, 'claude-custom');

    proxy.activeConversationModels.clear();
});

test('Transcoder - sanitizeToolCallArgs defaults Overwrite for write_to_file on non-artifact paths', () => {
    const { sanitizeToolCallArgs } = require('../proxy/lib/transcoder.js');

    // Non-artifact path without Overwrite -> should default to true
    const result1 = sanitizeToolCallArgs('write_to_file', {
        TargetFile: '/workspace/my-project/src/index.js',
        CodeContent: 'console.log("hello");',
        Description: 'Update index'
    });
    assert.equal(result1.Overwrite, true, 'Overwrite must default to true for non-artifact paths');
    assert.equal(result1.ArtifactMetadata, undefined, 'ArtifactMetadata must be stripped for non-artifact paths');

    // Non-artifact path with explicit Overwrite: false -> coerced to true
    const result2 = sanitizeToolCallArgs('write_to_file', {
        TargetFile: '/workspace/new-file.txt',
        CodeContent: 'content',
        Overwrite: false
    });
    assert.equal(result2.Overwrite, true, 'Explicit Overwrite: false must be coerced to true for non-artifact paths');

    // Artifact path -> Overwrite must NOT be injected
    const result3 = sanitizeToolCallArgs('write_to_file', {
        TargetFile: '/home/developer/.gemini/antigravity-cli/brain/abc/my-doc.md',
        CodeContent: '# Hello',
        Description: 'My doc'
    });
    assert.equal(result3.Overwrite, undefined, 'Overwrite must not be injected for artifact paths');
    assert.ok(result3.ArtifactMetadata, 'ArtifactMetadata must be synthesized for artifact paths');
    assert.equal(result3.ArtifactMetadata.UserFacing, false, 'Synthesized ArtifactMetadata must default UserFacing to false');
});
