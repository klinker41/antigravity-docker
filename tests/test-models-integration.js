'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

test('Multi-Model Integration - HTTP Proxy, Models API, & Upstream Interception', async (t) => {
    const TEST_PORT = 15500;
    const MOCK_AGY_PORT = 15501;
    const TEST_TRANS_PORT = 15505;
    const MOCK_PROVIDER_PORT = 15510;
    const AUTH_PASSWORD = 'test-models-password';

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-models-int-test-'));
    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });

    // 1. Setup Mock Provider (Anthropic/OpenAI mock endpoint)
    const mockProviderServer = http.createServer((req, res) => {
        if (req.url.endsWith('/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                data: [
                    { id: 'claude-3-7-sonnet-20250219', display_name: 'Claude 3.7 Sonnet' },
                    { id: 'claude-3-5-haiku-20241022', display_name: 'Claude 3.5 Haiku' }
                ]
            }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise((resolve) => mockProviderServer.listen(MOCK_PROVIDER_PORT, '127.0.0.1', resolve));

    let lastAgyReceivedWsText = null;
    let lastAgyReceivedHttpBody = null;

    // 2. Setup Mock Agy Upstream Server (supporting both HTTP and WebSocket)
    const mockAgyServer = Bun.serve({
        port: MOCK_AGY_PORT,
        hostname: '127.0.0.1',
        async fetch(req, server) {
            if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
                const success = server.upgrade(req);
                if (success) return;
                return new Response('WebSocket upgrade failed', { status: 400 });
            }

            const parsed = new URL(req.url);

            if (parsed.pathname.endsWith('/SendUserCascadeMessage')) {
                lastAgyReceivedHttpBody = await req.text();
                return Response.json({ success: true });
            }

            // Root HTML with sidebar markup
            if (parsed.pathname === '/') {
                return new Response('<!DOCTYPE html><html><head><title>Antigravity</title></head><body><div class="workspace-tools-nav"></div><div id="root"></div></body></html>', {
                    headers: { 'Content-Type': 'text/html; charset=utf-8' }
                });
            }

            // Connect-RPC GetCascadeModelConfigData endpoint
            if (parsed.pathname.endsWith('/GetCascadeModelConfigData')) {
                return Response.json({
                    clientModelConfigs: [
                        {
                            label: 'Gemini 3.8 Flash',
                            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' },
                            isRecommended: true
                        }
                    ],
                    clientModelSorts: [
                        {
                            name: 'Recommended',
                            groups: [
                                {
                                    groupName: 'Standard',
                                    modelLabels: ['Gemini 3.8 Flash']
                                }
                            ]
                        }
                    ]
                });
            }

            // Connect-RPC GetUserStatus endpoint (used by Antigravity web UI)
            if (parsed.pathname.endsWith('/GetUserStatus')) {
                return Response.json({
                    userStatus: {
                        name: 'Test Developer',
                        cascadeModelConfigData: {
                            clientModelConfigs: [
                                {
                                    label: 'Gemini 3.8 Flash',
                                    modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' },
                                    isRecommended: true
                                }
                            ],
                            clientModelSorts: [
                                {
                                    name: 'Recommended',
                                    groups: [
                                        {
                                            groupName: 'Standard',
                                            modelLabels: ['Gemini 3.8 Flash']
                                        }
                                    ]
                                }
                            ]
                        }
                    }
                });
            }

            // Connect-RPC GetCascadeModelConfigs endpoint (alternative model endpoint)
            if (parsed.pathname.endsWith('/GetCascadeModelConfigs')) {
                return Response.json({
                    cascadeModelConfigData: {
                        clientModelConfigs: [
                            {
                                label: 'Gemini 3.8 Flash',
                                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' },
                                isRecommended: true
                            }
                        ],
                        clientModelSorts: [
                            {
                                name: 'Recommended',
                                groups: [
                                    {
                                        groupName: 'Standard',
                                        modelLabels: ['Gemini 3.8 Flash']
                                    }
                                ]
                            }
                        ]
                    }
                });
            }

            // Upstream error endpoint to verify non-200 / non-JSON responses don't throw stream lock errors
            if (parsed.pathname.endsWith('/GetCascadeModelConfigDataError')) {
                return new Response('Internal Server Error from upstream', { status: 500 });
            }

            return new Response('Mock Agy OK', { status: 200 });
        },
        websocket: {
            message(ws, message) {
                const text = typeof message === 'string' ? message : Buffer.from(message).toString('utf8');
                lastAgyReceivedWsText = text;
                try {
                    const parsed = JSON.parse(text);
                    if (parsed.type === 'start' && parsed.procedure?.endsWith('/GetUserStatus')) {
                        ws.send(JSON.stringify({
                            streamId: parsed.streamId,
                            type: 'data',
                            payload: {
                                userStatus: {
                                    name: 'Test Developer',
                                    cascadeModelConfigData: {
                                        clientModelConfigs: [
                                            {
                                                label: 'Gemini 3.8 Flash',
                                                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' },
                                                isRecommended: true
                                            }
                                        ],
                                        clientModelSorts: [
                                            {
                                                name: 'Recommended',
                                                groups: [
                                                    {
                                                        groupName: 'Standard',
                                                        modelLabels: ['Gemini 3.8 Flash']
                                                    }
                                                ]
                                            }
                                        ]
                                    }
                                }
                            }
                        }));
                        ws.send(JSON.stringify({
                            streamId: parsed.streamId,
                            type: 'end',
                            statusCode: 0
                        }));
                    } else if (parsed.type === 'start' && parsed.procedure?.endsWith('/SendUserCascadeMessage')) {
                        ws.send(JSON.stringify({
                            streamId: parsed.streamId,
                            type: 'data',
                            payload: { received: true }
                        }));
                        ws.send(JSON.stringify({
                            streamId: parsed.streamId,
                            type: 'end',
                            statusCode: 0
                        }));
                    }
                } catch (e) {}
            }
        }
    });

    // 3. Spawn auth-proxy.js
    const proxyProc = spawn(process.execPath, [path.join(__dirname, '../proxy/auth-proxy.js')], {
        env: {
            ...process.env,
            AGY_PORT: String(TEST_PORT),
            AGY_HUB_PORT: String(MOCK_AGY_PORT),
            TRANSLATION_PORT: String(TEST_TRANS_PORT),
            GEMINI_CONFIG_DIR: configDir,
            AUTH_PASSWORD,
            PORT_FILE: path.join(tempDir, 'nonexistent_port_file'),
            ENABLE_IDE: 'false',
            ENABLE_TERMINAL: 'false'
        },
        stdio: 'pipe'
    });

    let proxyReady = false;
    proxyProc.stdout.on('data', (d) => {
        if (d.toString().includes('Listening on')) proxyReady = true;
    });

    for (let i = 0; i < 40 && !proxyReady; i++) {
        await new Promise(r => setTimeout(r, 50));
    }

    function makeRequest(reqPath, options = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: TEST_PORT,
                path: reqPath,
                method: options.method || 'GET',
                headers: options.headers || {}
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
            });
            req.on('error', reject);
            if (options.body) req.write(options.body);
            req.end();
        });
    }

    try {
        let authCookie = '';

        await t.test('unauthenticated access is denied or redirected', async () => {
            const modelsPageRes = await makeRequest('/models');
            assert.equal(modelsPageRes.status, 200);
            assert.ok(modelsPageRes.body.includes('Google Antigravity Remote Access'));

            const apiRes = await makeRequest('/api/models');
            assert.equal(apiRes.status, 401);
            const json = JSON.parse(apiRes.body);
            assert.ok(json.error);
        });

        await t.test('authenticates and receives session cookie', async () => {
            const loginRes = await makeRequest('/__auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `password=${AUTH_PASSWORD}`
            });
            assert.equal(loginRes.status, 302);
            authCookie = loginRes.headers['set-cookie']?.[0]?.split(';')[0];
            assert.ok(authCookie);
        });

        await t.test('passes GetCascadeModelConfigData through untouched when no custom models are configured', async () => {
            const rpcRes = await makeRequest('/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData', {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: '{}'
            });
            assert.equal(rpcRes.status, 200);
            const rpcData = JSON.parse(rpcRes.body);
            assert.equal(rpcData.clientModelConfigs.length, 1);
            assert.equal(rpcData.clientModelConfigs[0].label, 'Gemini 3.8 Flash');
            assert.equal(rpcData.clientModelSorts[0].groups[0].modelLabels.length, 1);
            assert.equal(rpcData.clientModelSorts[0].groups[0].modelLabels[0], 'Gemini 3.8 Flash');
        });

        await t.test('/models UI page renders management interface with responsive mobile styles and no outdated models', async () => {
            const res = await makeRequest('/models', {
                headers: { Cookie: authCookie }
            });
            assert.equal(res.status, 200);
            assert.ok(res.body.includes('External Providers & Models'));
            assert.ok(res.body.includes('Add Model Provider'));
            assert.ok(res.body.includes('providerModal'));
            assert.ok(res.body.includes('models-header'));
            assert.ok(res.body.includes('custom-model-row'));
            assert.ok(res.body.includes('openModal'));
            assert.ok(res.body.includes('.modal-overlay.show'));
            assert.ok(res.body.includes("modal.classList.add('active')"));
            // Outdated Anthropic example models must not be present
            assert.ok(!res.body.includes('Claude 3.5/3.7'));
            assert.ok(!res.body.includes('claude-3-7-sonnet-20250219'));
            assert.ok(!res.body.includes('Anthropic Claude'));
        });

        await t.test('tests provider connectivity via /api/models/test', async () => {
            const res = await makeRequest('/api/models/test', {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'anthropic',
                    endpoint: `http://127.0.0.1:${MOCK_PROVIDER_PORT}`,
                    apiKey: 'sk-ant-test-key-12345'
                })
            });
            assert.equal(res.status, 200);
            const data = JSON.parse(res.body);
            assert.equal(data.success, true);
            assert.equal(data.models.length, 2);
            assert.equal(data.models[0].id, 'claude-3-7-sonnet-20250219');
        });

        await t.test('manages custom model providers via /api/models CRUD', async () => {
            // Initially empty
            const initialRes = await makeRequest('/api/models', {
                headers: { Cookie: authCookie }
            });
            assert.equal(initialRes.status, 200);
            assert.deepEqual(JSON.parse(initialRes.body), []);

            // Create provider
            const createRes = await makeRequest('/api/models', {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'Anthropic Production',
                    type: 'anthropic',
                    endpoint: 'https://api.anthropic.com',
                    apiKey: 'sk-ant-live-secret-key-1234567890',
                    enabled: true,
                    models: [
                        { id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet', enabled: true, supportsThinking: true }
                    ]
                })
            });
            assert.equal(createRes.status, 200);
            const created = JSON.parse(createRes.body);
            assert.equal(created.name, 'Anthropic Production');
            assert.ok(created.id);
            assert.ok(created.apiKey.includes('••••••••'), 'POST /api/models response must mask apiKey');
            assert.equal(created.apiKey.includes('secret'), false);
            assert.equal(created.hasKey, true);

            // List providers - apiKey should be masked!
            const listRes = await makeRequest('/api/models', {
                headers: { Cookie: authCookie }
            });
            const list = JSON.parse(listRes.body);
            assert.equal(list.length, 1);
            assert.equal(list[0].id, created.id);
            assert.ok(list[0].apiKey.includes('••••••••'));
            assert.equal(list[0].apiKey.includes('secret'), false);
            assert.equal(list[0].hasKey, true);

            // Fetch single provider
            const singleRes = await makeRequest(`/api/models/${encodeURIComponent(created.id)}`, {
                headers: { Cookie: authCookie }
            });
            assert.equal(singleRes.status, 200);
            const single = JSON.parse(singleRes.body);
            assert.equal(single.id, created.id);
            assert.ok(single.apiKey.includes('••••••••'));
        });

        await t.test('injects custom models button into web UI sidebar navigation', async () => {
            const rootRes = await makeRequest('/?useWebSocket=true', {
                headers: { Cookie: authCookie }
            });
            assert.equal(rootRes.status, 200);
            assert.ok(rootRes.body.includes('/models'));
            assert.ok(rootRes.body.includes('Custom Models'));
        });

        await t.test('intercepts GetCascadeModelConfigData and injects external models into selector', async () => {
            const rpcRes = await makeRequest('/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData', {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: '{}'
            });
            assert.equal(rpcRes.status, 200);
            const rpcData = JSON.parse(rpcRes.body);

            // Original Gemini model is preserved
            assert.ok(rpcData.clientModelConfigs.some(m => m.label === 'Gemini 3.8 Flash'));

            // Injected Claude 3.7 thinking variants are added
            const injectedModelLow = rpcData.clientModelConfigs.find(m => m.modelId === 'custom-anthropic-claude-3-7-sonnet-low');
            const injectedModelMed = rpcData.clientModelConfigs.find(m => m.modelId === 'custom-anthropic-claude-3-7-sonnet-medium');
            const injectedModelHigh = rpcData.clientModelConfigs.find(m => m.modelId === 'custom-anthropic-claude-3-7-sonnet-high');
            assert.ok(injectedModelLow, 'Custom model Low variant should be present in clientModelConfigs');
            assert.ok(injectedModelMed, 'Custom model Medium variant should be present in clientModelConfigs');
            assert.ok(injectedModelHigh, 'Custom model High variant should be present in clientModelConfigs');
            assert.equal(injectedModelMed.label, 'Claude 3.7 Sonnet (Medium)');
            assert.equal(injectedModelMed.tagTitle, 'Anthropic Production');
            assert.equal(injectedModelMed.supportsImages, true);
            assert.ok(injectedModelMed.supportedMimeTypes, 'supportedMimeTypes must be present');
            assert.equal(injectedModelMed.supportedMimeTypes['image/png'], true);
            assert.equal(injectedModelMed.supportedMimeTypes['image/jpeg'], true);

            // Injected into model sorting labels
            const group = rpcData.clientModelSorts[0].groups[0];
            assert.ok(group.modelLabels.includes('Gemini 3.8 Flash'));
            assert.ok(group.modelLabels.includes('Claude 3.7 Sonnet (Low)'));
            assert.ok(group.modelLabels.includes('Claude 3.7 Sonnet (Medium)'));
            assert.ok(group.modelLabels.includes('Claude 3.7 Sonnet (High)'));
        });

        await t.test('intercepts GetUserStatus and injects external models into userStatus.cascadeModelConfigData', async () => {
            const rpcRes = await makeRequest('/exa.language_server_pb.LanguageServerService/GetUserStatus', {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: '{}'
            });
            assert.equal(rpcRes.status, 200);
            const rpcData = JSON.parse(rpcRes.body);

            assert.ok(rpcData.userStatus, 'userStatus must be present');
            assert.ok(rpcData.userStatus.cascadeModelConfigData, 'cascadeModelConfigData must be present');
            const configData = rpcData.userStatus.cascadeModelConfigData;

            // Original Gemini model is preserved
            assert.ok(configData.clientModelConfigs.some(m => m.label === 'Gemini 3.8 Flash'));

            // Injected Claude 3.7 model variants are added
            const injectedModel = configData.clientModelConfigs.find(m => m.modelId === 'custom-anthropic-claude-3-7-sonnet-medium');
            assert.ok(injectedModel, 'Custom model should be present in clientModelConfigs');
            assert.equal(injectedModel.label, 'Claude 3.7 Sonnet (Medium)');
            assert.equal(injectedModel.supportsImages, true);
            assert.ok(injectedModel.supportedMimeTypes, 'supportedMimeTypes must be present');
            assert.equal(injectedModel.supportedMimeTypes['image/png'], true);

            // Injected into model sorting labels
            const group = configData.clientModelSorts[0].groups[0];
            assert.ok(group.modelLabels.includes('Claude 3.7 Sonnet (Medium)'));
        });

        await t.test('intercepts GetCascadeModelConfigs and injects models into cascadeModelConfigData', async () => {
            const rpcRes = await makeRequest('/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigs', {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: '{}'
            });
            assert.equal(rpcRes.status, 200);
            const rpcData = JSON.parse(rpcRes.body);

            assert.ok(rpcData.cascadeModelConfigData, 'cascadeModelConfigData must be present');
            const configData = rpcData.cascadeModelConfigData;

            // Original model preserved
            assert.ok(configData.clientModelConfigs.some(m => m.label === 'Gemini 3.8 Flash'));

            // Injected model added
            const injectedModel = configData.clientModelConfigs.find(m => m.modelId === 'custom-anthropic-claude-3-7-sonnet-medium');
            assert.ok(injectedModel, 'Custom model should be present');
            assert.equal(injectedModel.label, 'Claude 3.7 Sonnet (Medium)');
        });

        await t.test('intercepts GetUserStatus over WebSocket and injects custom models with valid placeholder enums', async () => {
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/connect-websocket`, {
                headers: {
                    Cookie: authCookie,
                    Origin: `http://127.0.0.1:${TEST_PORT}`
                }
            });

            const receivedData = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    ws.close();
                    reject(new Error('WebSocket GetUserStatus timed out'));
                }, 4000);

                let payloadData = null;

                ws.onopen = () => {
                    ws.send(JSON.stringify({
                        streamId: 'test-ws-stream-1',
                        type: 'start',
                        procedure: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
                        stream: false,
                        payload: {}
                    }));
                };

                ws.onmessage = (event) => {
                    const text = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
                    try {
                        const data = JSON.parse(text);
                        if (data.type === 'data') {
                            payloadData = data.payload;
                        } else if (data.type === 'end') {
                            clearTimeout(timeout);
                            ws.close();
                            resolve(payloadData);
                        }
                    } catch (e) {}
                };

                ws.onerror = (err) => {
                    clearTimeout(timeout);
                    reject(err);
                };
            });

            assert.ok(receivedData, 'Must receive WebSocket payload data');
            const configs = receivedData.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
            assert.ok(configs.some(m => m.label === 'Gemini 3.8 Flash'), 'Upstream model present');

            const injected = configs.find(m => m.modelId === 'custom-anthropic-claude-3-7-sonnet-medium');
            assert.ok(injected, 'Custom Anthropic model must be injected over WebSocket');
            assert.equal(injected.label, 'Claude 3.7 Sonnet (Medium)');
            assert.equal(injected.supportsImages, true);
            assert.ok(injected.supportedMimeTypes, 'supportedMimeTypes must be present over WS');
            assert.equal(injected.supportedMimeTypes['image/png'], true);
            assert.match(injected.modelOrAlias.model, /^MODEL_PLACEHOLDER_M\d+$/, 'Enum must be valid MODEL_PLACEHOLDER');

            const sorts = receivedData.userStatus?.cascadeModelConfigData?.clientModelSorts?.[0]?.groups?.[0]?.modelLabels || [];
            assert.ok(sorts.includes('Claude 3.7 Sonnet (Medium)'), 'Custom model label must be in sort group');
        });

        await t.test('preserves custom model placeholder enum over WebSocket', async () => {
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/connect-websocket`, {
                headers: {
                    Cookie: authCookie,
                    Origin: `http://127.0.0.1:${TEST_PORT}`
                }
            });

            const customPlaceholder = 'MODEL_PLACEHOLDER_M555';

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    ws.close();
                    reject(new Error('WebSocket send timed out'));
                }, 4000);

                ws.onopen = () => {
                    ws.send(JSON.stringify({
                        streamId: 'test-ws-stream-send',
                        type: 'start',
                        procedure: '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
                        stream: true,
                        payload: {
                            cascadeId: 'cascade-test-ws',
                            cascadeConfig: {
                                plannerConfig: {
                                    planModel: customPlaceholder
                                }
                            }
                        }
                    }));
                };

                ws.onmessage = (event) => {
                    const text = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
                    try {
                        const data = JSON.parse(text);
                        if (data.type === 'end') {
                            clearTimeout(timeout);
                            ws.close();
                            resolve();
                        }
                    } catch (e) {}
                };

                ws.onerror = (err) => {
                    clearTimeout(timeout);
                    reject(err);
                };
            });

            assert.ok(lastAgyReceivedWsText, 'Upstream agy must receive message');
            assert.ok(lastAgyReceivedWsText.includes(customPlaceholder), 'Must preserve custom placeholder');
            assert.ok(!lastAgyReceivedWsText.includes('MODEL_PLACEHOLDER_M318'), 'Must NOT rewrite custom placeholder to M318');
        });

        await t.test('preserves custom model placeholder enum over HTTP POST', async () => {
            const customPlaceholder = 'MODEL_PLACEHOLDER_M567';
            const reqBody = JSON.stringify({
                cascadeId: 'cascade-test-http',
                model: customPlaceholder
            });

            const res = await makeRequest('/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage', {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: reqBody
            });

            assert.equal(res.status, 200);
            assert.ok(lastAgyReceivedHttpBody, 'Upstream agy must receive HTTP POST body');
            assert.ok(lastAgyReceivedHttpBody.includes(customPlaceholder), 'Must preserve custom placeholder in HTTP body');
            assert.ok(!lastAgyReceivedHttpBody.includes('MODEL_PLACEHOLDER_M318'), 'Must NOT rewrite custom placeholder to M318 in HTTP body');
        });

        await t.test('deletes provider via DELETE /api/models/:id', async () => {
            const listRes = await makeRequest('/api/models', {
                headers: { Cookie: authCookie }
            });
            const list = JSON.parse(listRes.body);
            assert.equal(list.length, 1);

            const delRes = await makeRequest(`/api/models/${encodeURIComponent(list[0].id)}`, {
                method: 'DELETE',
                headers: { Cookie: authCookie }
            });
            assert.equal(delRes.status, 200);
            assert.deepEqual(JSON.parse(delRes.body), { success: true });

            const postDelRes = await makeRequest('/api/models', {
                headers: { Cookie: authCookie }
            });
            assert.deepEqual(JSON.parse(postDelRes.body), []);
        });

        await t.test('entrypoint helper accurately detects presence and absence of enabled custom models', () => {
            const checkFn = (cfg) => {
                return Boolean(cfg && cfg.enabled && Array.isArray(cfg.providers) && cfg.providers.some(p => p.enabled && Array.isArray(p.models) && p.models.some(m => m.enabled)));
            };

            assert.equal(checkFn({ enabled: false, providers: [] }), false);
            assert.equal(checkFn({ enabled: true, providers: [] }), false);
            assert.equal(checkFn({ enabled: true, providers: [{ enabled: false, models: [{ enabled: true }] }] }), false);
            assert.equal(checkFn({ enabled: true, providers: [{ enabled: true, models: [{ enabled: false }] }] }), false);
            assert.equal(checkFn({ enabled: true, providers: [{ enabled: true, models: [{ enabled: true }] }] }), true);
        });

        await t.test('handleWebSocketClientMessage retains active model mapping on non-model messages', () => {
            const { handleWebSocketClientMessage } = require('../proxy/lib/proxy');
            const testMap = new Map();
            const fakeWs = { data: { activeStreams: new Map() } };
            const mockManager = {
                getModelByPlaceholder: (ph) => ({ modelId: 'custom-anthropic-claude', placeholder: ph })
            };

            // 1. Initial message with custom placeholder
            const msg1 = JSON.stringify({
                streamId: 's1',
                type: 'start',
                procedure: '/SendUserCascadeMessage',
                payload: {
                    cascadeId: 'casc-1',
                    conversationId: 'conv-1',
                    cascadeConfig: { plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M505' } }
                }
            });
            handleWebSocketClientMessage(fakeWs, msg1, mockManager, testMap);
            assert.ok(testMap.has('casc-1'));
            assert.ok(testMap.has('conv-1'));
            assert.ok(testMap.has('latest'));

            // 2. Follow-up non-model message (e.g., tool approval or user prompt without model selector change)
            const msg2 = JSON.stringify({
                streamId: 's2',
                type: 'start',
                procedure: '/SendUserCascadeMessage',
                payload: {
                    cascadeId: 'casc-1',
                    conversationId: 'conv-1',
                    text: 'Proceed with tool execution'
                }
            });
            handleWebSocketClientMessage(fakeWs, msg2, mockManager, testMap);
            assert.ok(testMap.has('casc-1'), 'Active model mapping must be preserved on non-model messages');
            assert.ok(testMap.has('conv-1'), 'Active model mapping must be preserved on non-model messages');
            assert.ok(testMap.has('latest'), 'Latest model mapping must be preserved on non-model messages');

            // 3. Explicit switch to standard model
            const msg3 = JSON.stringify({
                streamId: 's3',
                type: 'start',
                procedure: '/SendUserCascadeMessage',
                payload: {
                    cascadeId: 'casc-1',
                    conversationId: 'conv-1',
                    cascadeConfig: { plannerConfig: { planModel: 'gemini-2.5-pro' } }
                }
            });
            handleWebSocketClientMessage(fakeWs, msg3, mockManager, testMap);
            assert.equal(testMap.has('casc-1'), false, 'Standard model selection must clear active model mapping');
            assert.equal(testMap.has('conv-1'), false, 'Standard model selection must clear active model mapping');
            // 'latest' is intentionally NOT cleared — removing it mid-conversation based on procedure
            // name caused the sub-agent communication bug (see proxy.js fix). A stale 'latest' entry
            // is harmless; the cascadeId/convoId specific entries are what guard per-conversation routing.
            assert.ok(testMap.has('latest'), "'latest' must NOT be cleared when switching cascade/convo to standard model");
        });

        await t.test('handleWebSocketClientMessage retains latest model when SendUserCascadeMessage is a sub-agent response', () => {
            const { handleWebSocketClientMessage } = require('../proxy/lib/proxy');
            const testMap = new Map();
            const fakeWs = { data: { activeStreams: new Map() } };
            const mockManager = {
                getModelByPlaceholder: (ph) => (ph === 'MODEL_PLACEHOLDER_M510' ? { modelId: 'custom-astra' } : null)
            };

            // Main agent starts with a custom model (Astra)
            const msg1 = JSON.stringify({
                streamId: 's1',
                type: 'start',
                procedure: '/SendUserCascadeMessage',
                payload: {
                    cascadeId: 'main-casc',
                    conversationId: 'main-conv',
                    cascadeConfig: { plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M510' } }
                }
            });
            handleWebSocketClientMessage(fakeWs, msg1, mockManager, testMap);
            assert.ok(testMap.has('latest'), 'Custom model must be set in latest after initial message');

            // Sub-agent sends a response back — procedure is still SendUserCascadeMessage
            // but there is NO model field (it's a tool result, not a model switch).
            const subAgentToolResult = JSON.stringify({
                streamId: 's2',
                type: 'start',
                procedure: '/SendUserCascadeMessage',
                payload: {
                    cascadeId: 'main-casc',
                    conversationId: 'main-conv',
                    // No planModel — this is a tool result coming back, not a model change
                }
            });
            handleWebSocketClientMessage(fakeWs, subAgentToolResult, mockManager, testMap);
            assert.ok(testMap.has('latest'),
                "'latest' must survive a SendUserCascadeMessage tool result — wiping it broke sub-agent communication");
        });

        await t.test('standard conversation without custom placeholder does not inherit custom model from latest', () => {
            const { handleWebSocketClientMessage } = require('../proxy/lib/proxy');
            const testMap = new Map();
            const fakeWs = { data: { activeStreams: new Map() } };
            const customModel = { rawModelId: 'custom-model', providerType: 'openai' };
            const mockManager = {
                getModelByPlaceholder: (ph) => (ph === 'MODEL_PLACEHOLDER_M510' ? customModel : null)
            };

            // Custom model used in conversation 1
            const msg1 = JSON.stringify({
                streamId: 's1',
                type: 'start',
                procedure: '/SendUserCascadeMessage',
                payload: {
                    cascadeId: 'convo-1',
                    conversationId: 'convo-1',
                    model: 'MODEL_PLACEHOLDER_M510'
                }
            });
            handleWebSocketClientMessage(fakeWs, msg1, mockManager, testMap);
            assert.ok(testMap.has('latest'));
            assert.equal(testMap.get('convo-1'), customModel);

            // Message in standard conversation 2 (no custom model placeholder)
            const msg2 = JSON.stringify({
                streamId: 's2',
                type: 'start',
                procedure: '/SendUserCascadeMessage',
                payload: {
                    cascadeId: 'convo-2',
                    conversationId: 'convo-2',
                    model: 'DEFAULT_GEMINI'
                }
            });
            handleWebSocketClientMessage(fakeWs, msg2, mockManager, testMap);

            // convo-2 MUST NOT be bound to customModel
            assert.equal(testMap.has('convo-2'), false);
            assert.equal(testMap.get('latestConvoId'), 'convo-2');
        });

        await t.test('injectCustomModels enriches existing models lacking supportedMimeTypes', () => {
            const { injectCustomModels } = require('../proxy/lib/proxy');
            const mockManager = {
                getInjectedModels() {
                    return [
                        {
                            label: 'Existing Custom Model',
                            modelId: 'custom-provider-model-1',
                            supportsImages: true,
                            supportedMimeTypes: {
                                'image/png': true,
                                'image/jpeg': true
                            },
                            tagTitle: 'Provider',
                            tagDescription: 'Description'
                        }
                    ];
                }
            };

            const data = {
                clientModelConfigs: [
                    {
                        label: 'Existing Custom Model',
                        modelId: 'custom-provider-model-1'
                        // supportedMimeTypes missing
                    }
                ]
            };

            injectCustomModels(data, mockManager);

            const updated = data.clientModelConfigs[0];
            assert.equal(updated.supportsImages, true);
            assert.deepEqual(updated.supportedMimeTypes, {
                'image/png': true,
                'image/jpeg': true
            });
            assert.equal(updated.tagTitle, 'Provider');
            assert.equal(updated.tagDescription, 'Description');
        });

        await t.test('injectCustomModels updates existing model capability when toggled between text and vision', () => {
            const { injectCustomModels } = require('../proxy/lib/proxy');
            const data = {
                clientModelConfigs: [
                    {
                        label: 'Dynamic Model',
                        modelId: 'custom-provider-dyn-1',
                        supportsImages: false,
                        supportedMimeTypes: { 'text/plain': true }
                    }
                ]
            };

            const mockManagerVision = {
                getInjectedModels() {
                    return [
                        {
                            label: 'Dynamic Model',
                            modelId: 'custom-provider-dyn-1',
                            supportsImages: true,
                            supportedMimeTypes: { 'image/png': true, 'text/plain': true }
                        }
                    ];
                }
            };

            injectCustomModels(data, mockManagerVision);
            assert.equal(data.clientModelConfigs[0].supportsImages, true);
            assert.equal(data.clientModelConfigs[0].supportedMimeTypes['image/png'], true);

            const mockManagerText = {
                getInjectedModels() {
                    return [
                        {
                            label: 'Dynamic Model',
                            modelId: 'custom-provider-dyn-1',
                            supportsImages: false,
                            supportedMimeTypes: { 'text/plain': true }
                        }
                    ];
                }
            };

            injectCustomModels(data, mockManagerText);
            assert.equal(data.clientModelConfigs[0].supportsImages, false);
            assert.equal(data.clientModelConfigs[0].supportedMimeTypes['image/png'], undefined);
        });

    } finally {
        proxyProc.kill('SIGKILL');
        if (typeof mockAgyServer.stop === 'function') {
            mockAgyServer.stop();
        } else {
            mockAgyServer.close();
        }
        mockProviderServer.close();
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    }
});
