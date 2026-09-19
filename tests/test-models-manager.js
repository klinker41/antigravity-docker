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
    const {
        ModelsManager,
        getModelVariants,
        isThinkingModel,
        extractSupportsThinking,
        extractSupportsImages,
        DEFAULT_SUPPORTED_MIME_TYPES,
        TEXT_ONLY_SUPPORTED_MIME_TYPES
    } = require('../proxy/lib/models-manager');
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
        // Anthropic (1 enabled with supportsThinking: true -> Low, Medium, High = 3) + Ollama (1 enabled without thinking = 1) = 4 models
        assert.equal(injected.length, 4);

        const claudeLow = injected.find(m => m.modelId.endsWith('-low'));
        const claudeMed = injected.find(m => m.modelId.endsWith('-medium'));
        const claudeHigh = injected.find(m => m.modelId.endsWith('-high'));

        assert.ok(claudeLow, 'Claude Low should exist');
        assert.ok(claudeMed, 'Claude Medium should exist');
        assert.ok(claudeHigh, 'Claude High should exist');

        assert.equal(claudeLow.label, 'Claude 3.7 Sonnet (Low)');
        assert.equal(claudeMed.label, 'Claude 3.7 Sonnet (Medium)');
        assert.equal(claudeHigh.label, 'Claude 3.7 Sonnet (High)');

        assert.equal(claudeLow.thinkingLevel, 'low');
        assert.equal(claudeMed.thinkingLevel, 'medium');
        assert.equal(claudeHigh.thinkingLevel, 'high');

        assert.equal(claudeLow.thinkingBudget, 2048);
        assert.equal(claudeMed.thinkingBudget, 8192);
        assert.equal(claudeHigh.thinkingBudget, 32768);

        assert.equal(claudeLow.tagTitle, 'Anthropic Cloud Updated');
        assert.equal(claudeLow.supportsImages, true);
        assert.equal(claudeLow.isRecommended, true);
        assert.ok(claudeLow.supportedMimeTypes['image/jpeg'], 'Should support image/jpeg');
        assert.ok(claudeLow.supportedMimeTypes['image/png'], 'Should support image/png');
        assert.ok(claudeLow.supportedMimeTypes['image/webp'], 'Should support image/webp');
        assert.ok(claudeLow.supportedMimeTypes['image/gif'], 'Should support image/gif');
        assert.ok(claudeLow.supportedMimeTypes['application/json'], 'Should support application/json');

        // Verify distinct placeholder enums
        assert.match(claudeLow.modelOrAlias.model, /^MODEL_PLACEHOLDER_M\d+$/);
        assert.match(claudeMed.modelOrAlias.model, /^MODEL_PLACEHOLDER_M\d+$/);
        assert.match(claudeHigh.modelOrAlias.model, /^MODEL_PLACEHOLDER_M\d+$/);
        assert.notEqual(claudeLow.modelOrAlias.model, claudeMed.modelOrAlias.model);
        assert.notEqual(claudeMed.modelOrAlias.model, claudeHigh.modelOrAlias.model);

        const llama = injected.find(m => m.modelId.includes('llama3.3'));
        assert.ok(llama);
        assert.equal(llama.label, 'Llama 3.3');
        assert.equal(llama.supportsThinking, false);
        assert.equal(llama.supportsImages, true);
        assert.equal(llama.tagTitle, 'Local Ollama');
        assert.match(llama.modelOrAlias.model, /^MODEL_PLACEHOLDER_M\d+$/);
        assert.notEqual(claudeLow.modelOrAlias.model, llama.modelOrAlias.model);

        // Verify security: getInjectedModels MUST NOT contain credentials or sensitive server properties
        for (const model of injected) {
            assert.equal(model.apiKey, undefined, 'Client model config must NOT include apiKey');
            assert.equal(model.endpoint, undefined, 'Client model config must NOT include endpoint');
            assert.equal(model.providerType, undefined, 'Client model config must NOT include providerType');
            assert.equal(model.rawModelId, undefined, 'Client model config must NOT include rawModelId');
        }

        // Verify inverse lookup for server-side proxying DOES include provider credentials and thinking level
        const lookedUpLow = manager.getModelByPlaceholder(claudeLow.modelOrAlias.model);
        assert.ok(lookedUpLow);
        assert.equal(lookedUpLow.modelId, claudeLow.modelId);
        assert.equal(lookedUpLow.apiKey, 'sk-ant-test-key-123456789');
        assert.equal(lookedUpLow.endpoint, 'https://api.anthropic.com');
        assert.equal(lookedUpLow.providerType, 'anthropic');
        assert.equal(lookedUpLow.rawModelId, 'claude-3-7-sonnet-20250219');
        assert.equal(lookedUpLow.supportsThinking, true);
        assert.equal(lookedUpLow.supportsImages, true);
        assert.equal(lookedUpLow.thinkingLevel, 'low');
        assert.equal(lookedUpLow.thinkingBudget, 2048);

        const lookedUpHigh = manager.getModelByPlaceholder(claudeHigh.modelOrAlias.model);
        assert.ok(lookedUpHigh);
        assert.equal(lookedUpHigh.thinkingLevel, 'high');
        assert.equal(lookedUpHigh.thinkingBudget, 32768);

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
                        { id: 'gpt-4o-mini', object: 'model' },
                        { id: 'gpt-6-astra', object: 'model' }
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
            assert.ok(result.models.length >= 3);
            const gpt4o = result.models.find(m => m.id === 'gpt-4o');
            const astra = result.models.find(m => m.id === 'gpt-6-astra');
            assert.ok(gpt4o);
            assert.equal(gpt4o.supportsThinking, false);
            assert.ok(astra);
            assert.equal(astra.supportsThinking, true);
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
                    {
                        id: 'claude-3-7-sonnet-20250219',
                        display_name: 'Claude 3.7 Sonnet',
                        capabilities: {
                            thinking: { supported: true }
                        }
                    }
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
            assert.equal(result.models[0].supportsThinking, true);
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

    await t.test('correctly sets tagTitle to provider name for Ollama and keeps model label clean', () => {
        const ollamaProvider = manager.saveProvider({
            name: 'ollama',
            type: 'openai',
            endpoint: 'https://ollama.example.com',
            apiKey: 'test-key',
            enabled: true,
            models: [
                { id: 'gemma4:e2b', label: 'gemma4:e2b', enabled: true },
                { id: 'gemma4:12b', label: 'gemma4:12b', enabled: true }
            ]
        });

        const injected = manager.getInjectedModels();
        const gemma2b = injected.find(m => m.modelId.includes('gemma4:e2b'));
        assert.ok(gemma2b);
        assert.equal(gemma2b.label, 'gemma4:e2b');
        assert.equal(gemma2b.tagTitle, 'ollama');
        assert.equal(gemma2b.tagDescription, 'ollama');

        manager.deleteProvider(ollamaProvider.id);
    });

    await t.test('getModelVariants expands thinking models and respects pre-labeled effort', () => {
        // 1. Unadorned thinking model expands into 3 variants
        const unadorned = getModelVariants({ id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet', supportsThinking: true });
        assert.equal(unadorned.length, 3);
        assert.deepEqual(unadorned.map(v => v.thinkingLevel), ['low', 'medium', 'high']);
        assert.deepEqual(unadorned.map(v => v.thinkingBudget), [2048, 8192, 32768]);
        assert.equal(unadorned[0].label, 'Claude 3.7 Sonnet (Low)');
        assert.equal(unadorned[0].variantSuffix, '-low');

        // 2. Pre-labeled model with (High) does not expand
        const preLabeledHigh = getModelVariants({ id: 'claude-3-7-high', label: 'Claude 3.7 Sonnet (High)', supportsThinking: true });
        assert.equal(preLabeledHigh.length, 1);
        assert.equal(preLabeledHigh[0].label, 'Claude 3.7 Sonnet (High)');
        assert.equal(preLabeledHigh[0].thinkingLevel, 'high');
        assert.equal(preLabeledHigh[0].thinkingBudget, 32768);
        assert.equal(preLabeledHigh[0].variantSuffix, '-high');

        // 3. Pre-labeled model with (Medium thinking) does not expand
        const preLabeledMed = getModelVariants({ id: 'o3-mini', label: 'o3-mini (medium thinking)', supportsThinking: true });
        assert.equal(preLabeledMed.length, 1);
        assert.equal(preLabeledMed[0].label, 'o3-mini (medium thinking)');
        assert.equal(preLabeledMed[0].thinkingLevel, 'medium');
        assert.equal(preLabeledMed[0].thinkingBudget, 8192);
        assert.equal(preLabeledMed[0].variantSuffix, '-medium');

        // 4. Non-thinking model returns single item without thinking props
        const nonThinking = getModelVariants({ id: 'gpt-4o', label: 'GPT-4o', supportsThinking: false });
        assert.equal(nonThinking.length, 1);
        assert.equal(nonThinking[0].label, 'GPT-4o');
        assert.equal(nonThinking[0].supportsThinking, false);
        assert.equal(nonThinking[0].thinkingLevel, undefined);
        assert.equal(nonThinking[0].variantSuffix, '');
    });

    await t.test('isThinkingModel correctly classifies reasoning models including astra and o4', () => {
        // Thinking models
        assert.equal(isThinkingModel('gpt-6-astra'), true);
        assert.equal(isThinkingModel('astra-latest'), true);
        assert.equal(isThinkingModel('o4-mini'), true);
        assert.equal(isThinkingModel('o4-mini-2025-04-16'), true);
        assert.equal(isThinkingModel('claude-fable-5-1'), true);
        assert.equal(isThinkingModel('deepseek-r1'), true);
        assert.equal(isThinkingModel('custom-model', 'DeepSeek Reasoner'), true);
        assert.equal(isThinkingModel('custom-model', 'Qwen Thinking 32B'), true);

        // Non-thinking models and false-positive prevention (word boundaries)
        assert.equal(isThinkingModel('gpt-4o'), false);
        assert.equal(isThinkingModel('llama3.3:70b'), false);
        assert.equal(isThinkingModel('gemma4:e2b'), false);
        assert.equal(isThinkingModel('text-embedding-3-large'), false);
        assert.equal(isThinkingModel('server1-7b'), false);
        assert.equal(isThinkingModel('gpt-3.5-turbo1'), false);
        assert.equal(isThinkingModel('macro1'), false);
        assert.equal(isThinkingModel('master1'), false);
    });

    await t.test('extractSupportsThinking detects capabilities from provider metadata and fallback', () => {
        // 1. Anthropic capabilities metadata
        assert.equal(extractSupportsThinking({ id: 'unknown-id', capabilities: { thinking: { supported: true } } }, 'anthropic'), true);
        assert.equal(extractSupportsThinking({ id: 'unknown-id', capabilities: { effort: { supported: true } } }, 'anthropic'), true);
        assert.equal(extractSupportsThinking({ id: 'unknown-id', capabilities: { reasoning: true } }, 'anthropic'), true);

        // 2. OpenRouter / LiteLLM parameter metadata
        assert.equal(extractSupportsThinking({ id: 'unknown-id', supported_parameters: ['reasoning', 'tools'] }, 'openai'), true);
        assert.equal(extractSupportsThinking({ id: 'unknown-id', supported_parameters: ['thinking'] }, 'openai'), true);

        // 3. Direct boolean properties
        assert.equal(extractSupportsThinking({ id: 'unknown-id', supports_thinking: true }, 'openai'), true);
        assert.equal(extractSupportsThinking({ id: 'unknown-id', supportsThinking: true }, 'openai'), true);

        // 4. Explicit false capability metadata overrides name-based heuristics
        assert.equal(extractSupportsThinking({ id: 'claude-3-5-sonnet', capabilities: { thinking: { supported: false } } }, 'anthropic'), false);
        assert.equal(extractSupportsThinking({ id: 'claude-3-5-sonnet', supportsThinking: false }, 'anthropic'), false);
        assert.equal(extractSupportsThinking({ id: 'gpt-6-astra', supports_thinking: false }, 'openai'), false);

        // 5. Server intelligence fallback when provider omits metadata (OpenAI)
        assert.equal(extractSupportsThinking({ id: 'gpt-6-astra' }, 'openai'), true);
        assert.equal(extractSupportsThinking({ id: 'o4-mini' }, 'openai'), true);
        assert.equal(extractSupportsThinking({ id: 'o3-mini' }, 'openai'), true);
        assert.equal(extractSupportsThinking({ id: 'deepseek-r1' }, 'openai'), true);
        assert.equal(extractSupportsThinking({ id: 'custom-model', display_name: 'DeepSeek Reasoner' }, 'openai'), true);

        // 6. Non-thinking models
        assert.equal(extractSupportsThinking({ id: 'gpt-4o' }, 'openai'), false);
        assert.equal(extractSupportsThinking({ id: 'llama-3.3-70b' }, 'openai'), false);
        assert.equal(extractSupportsThinking(null, 'openai'), false);
    });

    await t.test('persists provider and model timeouts and cascades in getModelByPlaceholder', () => {
        manager.saveProvider({
            name: 'Timeout Provider',
            type: 'openai',
            endpoint: 'http://127.0.0.1:11434',
            timeout: 120000,
            models: [
                { id: 'm-default', label: 'Inherits Provider Timeout' },
                { id: 'm-override', label: 'Custom Timeout', timeout: 300000 },
                { id: 'm-invalid', label: 'Invalid Timeout', timeout: -50 }
            ]
        });

        const placeholderDefault = manager.getPlaceholderEnum('custom-openai-m-default');
        const modelDefault = manager.getModelByPlaceholder(placeholderDefault);
        assert.equal(modelDefault.timeout, 120000);

        const placeholderOverride = manager.getPlaceholderEnum('custom-openai-m-override');
        const modelOverride = manager.getModelByPlaceholder(placeholderOverride);
        assert.equal(modelOverride.timeout, 300000);

        const placeholderInvalid = manager.getPlaceholderEnum('custom-openai-m-invalid');
        const modelInvalid = manager.getModelByPlaceholder(placeholderInvalid);
        assert.equal(modelInvalid.timeout, 120000); // Falls back to provider timeout
    });

    await t.test('extractSupportsImages correctly identifies vision and non-vision models', () => {
        // Standard models support images
        assert.equal(extractSupportsImages({ id: 'claude-3-7-sonnet' }, 'anthropic'), true);
        assert.equal(extractSupportsImages({ id: 'gpt-4o' }, 'openai'), true);
        assert.equal(extractSupportsImages({ id: 'gpt-4o-mini' }, 'openai'), true);
        assert.equal(extractSupportsImages({ id: 'gemini-2.0-flash' }, 'openai'), true);

        // Explicit boolean capabilities
        assert.equal(extractSupportsImages({ id: 'custom-model', supportsImages: true }), true);
        assert.equal(extractSupportsImages({ id: 'custom-model', supportsImages: false }), false);
        assert.equal(extractSupportsImages({ id: 'custom-model', supports_images: false }), false);
        assert.equal(extractSupportsImages({ id: 'custom-model', supports_vision: false }), false);
        assert.equal(extractSupportsImages({ id: 'custom-model', supports_vision: true }), true);
        assert.equal(extractSupportsImages({ id: 'custom-model', capabilities: { vision: false } }), false);
        assert.equal(extractSupportsImages({ id: 'custom-model', capabilities: { vision: true } }), true);
        assert.equal(extractSupportsImages({ id: 'custom-model', capabilities: { vision: { supported: false } } }), false);
        assert.equal(extractSupportsImages({ id: 'custom-model', capabilities: { vision: { supported: true } } }), true);
        assert.equal(extractSupportsImages({ id: 'custom-model', capabilities: { images: { supported: false } } }), false);
        assert.equal(extractSupportsImages({ id: 'custom-model', capabilities: { images: { supported: true } } }), true);

        // Verify HEIC/HEIF are excluded from default vision types to avoid provider 400 errors
        assert.equal(DEFAULT_SUPPORTED_MIME_TYPES['image/heic'], undefined);
        assert.equal(DEFAULT_SUPPORTED_MIME_TYPES['image/heif'], undefined);

        // Non-vision model keywords
        assert.equal(extractSupportsImages({ id: 'text-embedding-3-small' }, 'openai'), false);
        assert.equal(extractSupportsImages({ id: 'text-embedding-ada-002' }, 'openai'), false);
        assert.equal(extractSupportsImages({ id: 'whisper-1' }, 'openai'), false);
        assert.equal(extractSupportsImages({ id: 'tts-1-hd' }, 'openai'), false);
        assert.equal(extractSupportsImages({ id: 'text-moderation-latest' }, 'openai'), false);
        assert.equal(extractSupportsImages({ id: 'dall-e-3' }, 'openai'), false);

        assert.equal(extractSupportsImages(null), true);
    });

    await t.test('respects supportsImages: false and assigns TEXT_ONLY_SUPPORTED_MIME_TYPES', () => {
        manager.saveProvider({
            name: 'Text Only Provider',
            type: 'openai',
            endpoint: 'http://127.0.0.1:11434',
            models: [
                { id: 'pure-text-model', label: 'Pure Text Model', supportsImages: false, supportsThinking: false }
            ]
        });

        const injected = manager.getInjectedModels();
        const textModel = injected.find(m => m.modelId.includes('pure-text-model'));
        assert.ok(textModel);
        assert.equal(textModel.supportsImages, false);
        assert.equal(textModel.supportedMimeTypes['image/png'], undefined);
        assert.equal(textModel.supportedMimeTypes['image/jpeg'], undefined);
        assert.equal(textModel.supportedMimeTypes['image/gif'], undefined);
        assert.equal(textModel.supportedMimeTypes['application/json'], true);
        assert.equal(textModel.supportedMimeTypes['text/plain'], true);

        const lookedUp = manager.getModelByPlaceholder(textModel.modelOrAlias.model);
        assert.ok(lookedUp);
        assert.equal(lookedUp.supportsImages, false);
    });
});
