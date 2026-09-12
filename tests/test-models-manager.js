const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

test('Models Manager - Configuration, CRUD & Provider Connectivity', async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-models-test-'));
    const configPath = path.join(tempDir, 'custom_models.json');

    // Create fresh instance of ModelsManager with isolated config path
    const { ModelsManager } = require('../proxy/lib/models-manager');
    const manager = new ModelsManager({ configPath });

    t.after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    await t.test('initializes with default empty configuration when file does not exist', () => {
        const config = manager.getConfig();
        assert.equal(config.enabled, false);
        assert.deepEqual(config.providers, []);
        assert.equal(manager.hasEnabledModels(), false);
    });

    await t.test('saves and retrieves a new Anthropic provider', () => {
        const provider = manager.saveProvider({
            name: 'Anthropic Cloud',
            type: 'anthropic',
            endpoint: 'https://api.anthropic.com',
            apiKey: 'sk-ant-test-key-123456789',
            enabled: true,
            models: [
                { id: 'claude-3-7-sonnet-20250219', label: 'Claude 3.7 Sonnet', enabled: true, supportsThinking: true },
                { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet', enabled: false, supportsThinking: false }
            ]
        });

        assert.ok(provider.id, 'Provider should receive generated ID');
        assert.equal(provider.name, 'Anthropic Cloud');
        assert.equal(provider.type, 'anthropic');
        assert.equal(provider.enabled, true);
        assert.equal(provider.models.length, 2);

        // Verify persisted file on disk
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(raw.providers.length, 1);
        assert.equal(raw.providers[0].id, provider.id);
        assert.equal(raw.providers[0].apiKey, 'sk-ant-test-key-123456789');
    });

    await t.test('listProviders returns masked API keys for UI safety', () => {
        const list = manager.listProviders();
        assert.equal(list.length, 1);
        assert.notEqual(list[0].apiKey, 'sk-ant-test-key-123456789');
        assert.match(list[0].apiKey, /••••/);
        assert.ok(list[0].apiKey.endsWith('6789'));
    });

    await t.test('updates an existing provider without wiping secret if not provided', () => {
        const list = manager.listProviders();
        const existingId = list[0].id;

        const updated = manager.saveProvider({
            id: existingId,
            name: 'Anthropic Cloud Updated',
            type: 'anthropic',
            endpoint: 'https://api.anthropic.com',
            apiKey: '', // Empty means retain existing key
            enabled: true,
            models: [
                { id: 'claude-3-7-sonnet-20250219', label: 'Claude 3.7 Sonnet', enabled: true, supportsThinking: true }
            ]
        });

        assert.equal(updated.name, 'Anthropic Cloud Updated');
        const retrieved = manager.getProvider(existingId);
        assert.equal(retrieved.apiKey, 'sk-ant-test-key-123456789');
        assert.equal(retrieved.models.length, 1);
    });

    await t.test('saves an OpenAI-compatible provider (Ollama)', () => {
        const ollama = manager.saveProvider({
            name: 'Local Ollama',
            type: 'openai',
            endpoint: 'http://127.0.0.1:11434/v1',
            apiKey: '',
            enabled: true,
            models: [
                { id: 'llama3.3', label: 'Llama 3.3', enabled: true }
            ]
        });

        assert.ok(ollama.id);
        assert.equal(ollama.type, 'openai');
        assert.equal(manager.listProviders().length, 2);
    });

    await t.test('generates Antigravity-compatible model entries for enabled models', () => {
        const injected = manager.getInjectedModels();
        // Anthropic (1 enabled) + Ollama (1 enabled) = 2 models
        assert.equal(injected.length, 2);

        const claude = injected.find(m => m.modelId.includes('claude-3-7-sonnet'));
        assert.ok(claude);
        assert.equal(claude.label, 'Claude 3.7 Sonnet (Anthropic)');
        assert.equal(claude.supportsImages, true);
        assert.equal(claude.isRecommended, true);
        assert.match(claude.modelOrAlias.model, /^MODEL_PLACEHOLDER_M\d+$/);

        const llama = injected.find(m => m.modelId.includes('llama3.3'));
        assert.ok(llama);
        assert.equal(llama.label, 'Llama 3.3 (OpenAI)');
        assert.match(llama.modelOrAlias.model, /^MODEL_PLACEHOLDER_M\d+$/);
        assert.notEqual(claude.modelOrAlias.model, llama.modelOrAlias.model);

        // Verify inverse lookup
        const lookedUp = manager.getModelByPlaceholder(claude.modelOrAlias.model);
        assert.ok(lookedUp);
        assert.equal(lookedUp.modelId, claude.modelId);

        // Verify collision handling and capacity limit
        const used = new Set();
        for (let i = 0; i < 150; i++) {
            const assigned = manager.getPlaceholderEnum(`test-model-${i}`, used);
            assert.match(assigned, /^MODEL_PLACEHOLDER_M(5\d\d|6[0-4]\d)$/);
        }
        assert.throws(() => {
            manager.getPlaceholderEnum('overflow-model', used);
        }, /capacity/);

        assert.equal(manager.hasEnabledModels(), true);
    });

    await t.test('tests provider connectivity with mock OpenAI /models endpoint', async () => {
        const mockServer = http.createServer((req, res) => {
            if (req.url === '/models' || req.url === '/v1/models') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    object: 'list',
                    data: [
                        { id: 'gpt-4o', object: 'model' },
                        { id: 'gpt-4o-mini', object: 'model' }
                    ]
                }));
            } else {
                res.writeHead(404);
                res.end();
            }
        });

        await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
        const port = mockServer.address().port;

        try {
            const result = await manager.testProvider({
                type: 'openai',
                endpoint: `http://127.0.0.1:${port}`,
                apiKey: 'test-token'
            });

            assert.equal(result.success, true);
            assert.ok(result.models.length >= 2);
            assert.ok(result.models.some(m => m.id === 'gpt-4o'));
        } finally {
            mockServer.close();
        }
    });

    await t.test('reuses stored API key when testing provider without supplying apiKey', async () => {
        const list = manager.listProviders();
        const anthropicProvider = list.find(p => p.type === 'anthropic');
        assert.ok(anthropicProvider, 'Anthropic provider should exist');

        let receivedApiKey = null;
        const mockServer = http.createServer((req, res) => {
            receivedApiKey = req.headers['x-api-key'];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                data: [
                    { id: 'claude-3-7-sonnet-20250219', display_name: 'Claude 3.7 Sonnet' }
                ]
            }));
        });

        await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
        const port = mockServer.address().port;

        try {
            // Omit apiKey and provide existing provider id
            const result = await manager.testProvider({
                id: anthropicProvider.id,
                type: 'anthropic',
                endpoint: `http://127.0.0.1:${port}`
            });

            assert.equal(result.success, true);
            assert.equal(receivedApiKey, 'sk-ant-test-key-123456789');
            assert.equal(result.models.length, 1);
            assert.equal(result.models[0].id, 'claude-3-7-sonnet-20250219');
        } finally {
            mockServer.close();
        }
    });

    await t.test('deletes a provider by ID', () => {
        const list = manager.listProviders();
        assert.equal(list.length, 2);

        const deleted = manager.deleteProvider(list[0].id);
        assert.equal(deleted, true);
        assert.equal(manager.listProviders().length, 1);
    });
});
