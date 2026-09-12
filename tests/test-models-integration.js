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

    // 2. Setup Mock Agy Upstream Server
    const mockAgyServer = http.createServer((req, res) => {
        const parsed = new URL(req.url, `http://127.0.0.1:${MOCK_AGY_PORT}`);

        // Root HTML with sidebar markup
        if (parsed.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<!DOCTYPE html><html><head><title>Antigravity</title></head><body><div class="workspace-tools-nav"></div><div id="root"></div></body></html>');
            return;
        }

        // Connect-RPC GetCascadeModelConfigData endpoint
        if (parsed.pathname.endsWith('/GetCascadeModelConfigData')) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                clientModelConfigs: [
                    {
                        label: 'Gemini 3.8 Flash',
                        modelOrAlias: { model: 'gemini-3.8-flash' },
                        isRecommended: true
                    }
                ],
                clientModelSorts: [
                    {
                        groups: [
                            {
                                groupName: 'Standard',
                                modelLabels: ['Gemini 3.8 Flash']
                            }
                        ]
                    }
                ]
            }));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Mock Agy OK');
    });
    await new Promise((resolve) => mockAgyServer.listen(MOCK_AGY_PORT, '127.0.0.1', resolve));

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

        await t.test('/models UI page renders management interface', async () => {
            const res = await makeRequest('/models', {
                headers: { Cookie: authCookie }
            });
            assert.equal(res.status, 200);
            assert.ok(res.body.includes('External Providers & Models'));
            assert.ok(res.body.includes('Add Model Provider'));
            assert.ok(res.body.includes('providerModal'));
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

            // Injected Claude 3.7 model is added
            const injectedModel = rpcData.clientModelConfigs.find(m => m.modelId === 'custom-anthropic-claude-3-7-sonnet');
            assert.ok(injectedModel, 'Custom model should be present in clientModelConfigs');
            assert.equal(injectedModel.label, 'Claude 3.7 Sonnet (Anthropic)');
            assert.equal(injectedModel.tagTitle, 'Anthropic');

            // Injected into model sorting labels
            const group = rpcData.clientModelSorts[0].groups[0];
            assert.ok(group.modelLabels.includes('Gemini 3.8 Flash'));
            assert.ok(group.modelLabels.includes('Claude 3.7 Sonnet (Anthropic)'));
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

    } finally {
        proxyProc.kill('SIGKILL');
        mockAgyServer.close();
        mockProviderServer.close();
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    }
});
