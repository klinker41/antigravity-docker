'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const HOME_DIR = process.env.HOME || '/home/developer';
const GEMINI_CONFIG_DIR = process.env.GEMINI_CONFIG_DIR || path.join(HOME_DIR, '.gemini/config');
const DEFAULT_CONFIG_PATH = path.join(GEMINI_CONFIG_DIR, 'custom_models.json');

const PLACEHOLDER_START = 500;
const PLACEHOLDER_COUNT = 150;

const CUSTOM_PLACEHOLDER_REGEX = /^MODEL_PLACEHOLDER_M(5\d\d|6[0-4]\d)$/;
const CUSTOM_PLACEHOLDER_REGEX_GLOBAL = /MODEL_PLACEHOLDER_M(5\d\d|6[0-4]\d)/g;

const THINKING_LEVELS = ['Low', 'Medium', 'High'];
const EFFORT_REGEX = /^(.*?)\s*\((low|medium|high)(?:\s+thinking)?\)\s*$/i;

const THINKING_BUDGETS = {
    low: 2048,
    medium: 8192,
    high: 32768
};

const THINKING_MODEL_REGEX = /(?:claude|\b(?:o[134]|r1)\b|astra|gpt-6|reason(?:er)?|think(?:ing)?)/i;

/**
 * Determines whether a model ID or label represents a model with thinking/reasoning capabilities.
 */
function isThinkingModel(modelId, label = '') {
    const combined = `${modelId || ''} ${label || ''}`;
    return THINKING_MODEL_REGEX.test(combined);
}

/**
 * Extracts whether a model returned by a provider supports thinking / reasoning.
 * Checks provider-declared capabilities metadata (e.g. Anthropic, OpenRouter, LiteLLM)
 * and falls back to server-side model identification when providers omit capabilities.
 */
function extractSupportsThinking(m, _providerType) {
    if (!m || typeof m !== 'object') return false;

    // 1. Direct provider capability metadata (explicit booleans take precedence)
    if (typeof m.supportsThinking === 'boolean') return m.supportsThinking;
    if (typeof m.supports_thinking === 'boolean') return m.supports_thinking;
    if (m.capabilities && typeof m.capabilities === 'object') {
        if (typeof m.capabilities.thinking?.supported === 'boolean') return m.capabilities.thinking.supported;
        if (typeof m.capabilities.effort?.supported === 'boolean') return m.capabilities.effort.supported;
        if (typeof m.capabilities.reasoning === 'boolean') return m.capabilities.reasoning;
    }
    if (Array.isArray(m.supported_parameters)) {
        if (m.supported_parameters.includes('reasoning') || m.supported_parameters.includes('thinking')) {
            return true;
        }
    }

    // 2. Server-side model intelligence fallback when provider does not expose capabilities (e.g. vanilla OpenAI)
    const id = String(m.id || m.name || m.model || '');
    const label = String(m.display_name || m.name || m.id || m.model || '');
    return isThinkingModel(id, label);
}

const DEFAULT_ALLOWED_TIERS = [
    'TEAMS_TIER_PRO',
    'TEAMS_TIER_TEAMS',
    'TEAMS_TIER_ENTERPRISE_SELF_HOSTED',
    'TEAMS_TIER_ENTERPRISE_SAAS',
    'TEAMS_TIER_HYBRID',
    'TEAMS_TIER_PRO_ULTIMATE'
];

const DEFAULT_SUPPORTED_MIME_TYPES = {
    'application/json': true,
    'application/pdf': true,
    'application/x-javascript': true,
    'application/x-python-code': true,
    'application/x-typescript': true,
    'image/jpeg': true,
    'image/png': true,
    'image/webp': true,
    'text/css': true,
    'text/html': true,
    'text/javascript': true,
    'text/markdown': true,
    'text/plain': true
};

/**
 * Returns the array of variants (low, medium, high or single) for a given model definition.
 */
function getModelVariants(model) {
    const baseLabel = String(model.label || '').trim() || String(model.id || '').trim();
    if (!model.supportsThinking) {
        return [{
            label: baseLabel,
            variantSuffix: '',
            supportsThinking: false
        }];
    }
    const match = EFFORT_REGEX.exec(baseLabel);
    if (match) {
        const effort = match[2].toLowerCase();
        return [{
            label: baseLabel,
            variantSuffix: `-${effort}`,
            supportsThinking: true,
            thinkingLevel: effort,
            thinkingBudget: THINKING_BUDGETS[effort] || 2048
        }];
    }
    return THINKING_LEVELS.map(effort => ({
        label: `${baseLabel} (${effort})`,
        variantSuffix: `-${effort.toLowerCase()}`,
        supportsThinking: true,
        thinkingLevel: effort.toLowerCase(),
        thinkingBudget: THINKING_BUDGETS[effort.toLowerCase()]
    }));
}


/**
 * Checks whether an enum string belongs to the custom placeholder range (MODEL_PLACEHOLDER_M500..M649).
 */
function isCustomPlaceholder(placeholderEnum) {
    if (!placeholderEnum || typeof placeholderEnum !== 'string') return false;
    return CUSTOM_PLACEHOLDER_REGEX.test(placeholderEnum);
}

/**
 * Finds all custom model placeholder enums in a text string.
 */
function matchCustomPlaceholders(str) {
    if (!str || typeof str !== 'string') return [];
    return str.match(/MODEL_PLACEHOLDER_M(5\d\d|6[0-4]\d)/g) || [];
}

/**
 * Masks an API key for safe UI display (e.g. sk-••••••••1234).
 */
function maskApiKey(key) {
    if (!key || typeof key !== 'string') return '';
    const trimmed = key.trim();
    if (trimmed.length <= 8) return '••••••••';
    const prefix = trimmed.slice(0, 4);
    const suffix = trimmed.slice(-4);
    return `${prefix}••••••••${suffix}`;
}

/**
 * Generates a clean URL-friendly slug ID.
 */
function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || crypto.randomUUID().slice(0, 8);
}

class ModelsManager {
    constructor(options = {}) {
        this.configPath = options.configPath || DEFAULT_CONFIG_PATH;
    }

    /**
     * Reads the current custom models configuration from disk.
     */
    getConfig() {
        try {
            if (fs.existsSync(this.configPath)) {
                const content = fs.readFileSync(this.configPath, 'utf8').trim();
                if (content) {
                    const parsed = JSON.parse(content);
                    return {
                        enabled: Boolean(parsed.enabled),
                        providers: Array.isArray(parsed.providers) ? parsed.providers : []
                    };
                }
            }
        } catch (err) {
            console.error('[ModelsManager] Error reading config file:', err.message);
        }
        return { enabled: false, providers: [] };
    }

    _calculateEnabled(providers) {
        return Array.isArray(providers) && providers.some(p => p.enabled && Array.isArray(p.models) && p.models.some(m => m.enabled));
    }

    /**
     * Saves configuration to disk atomically with restricted file permissions.
     */
    saveConfig(config) {
        const dir = path.dirname(this.configPath);
        fs.mkdirSync(dir, { recursive: true });

        const safeConfig = {
            enabled: Boolean(config.enabled),
            providers: Array.isArray(config.providers) ? config.providers : []
        };

        const tempFile = `${this.configPath}.tmp.${Date.now()}`;
        fs.writeFileSync(tempFile, JSON.stringify(safeConfig, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tempFile, this.configPath);
        try {
            fs.chmodSync(this.configPath, 0o600);
        } catch (e) {}
        return safeConfig;
    }

    /**
     * Returns list of configured providers with API keys masked for display.
     */
    listProviders() {
        const config = this.getConfig();
        return config.providers.map(p => ({
            ...p,
            apiKey: maskApiKey(p.apiKey),
            hasKey: Boolean(p.apiKey && p.apiKey.trim().length > 0)
        }));
    }

    /**
     * Returns raw provider by ID including unmasked secret.
     */
    getProvider(id) {
        const config = this.getConfig();
        return config.providers.find(p => p.id === id) || null;
    }

    /**
     * Creates or updates a provider.
     */
    saveProvider(providerData) {
        if (!providerData || typeof providerData !== 'object') {
            throw new Error('Invalid provider data');
        }

        const config = this.getConfig();
        let id = providerData.id;
        const isUpdate = Boolean(id);

        let existing = null;
        if (isUpdate) {
            existing = config.providers.find(p => p.id === id);
            if (!existing) {
                throw new Error(`Provider with ID '${id}' not found`);
            }
        } else {
            id = slugify(providerData.name || 'custom-provider');
            // Ensure unique ID
            let counter = 1;
            let candidateId = id;
            while (config.providers.some(p => p.id === candidateId)) {
                candidateId = `${id}-${counter++}`;
            }
            id = candidateId;
        }

        // Retain existing API key if updating and key was left blank, unless explicitly cleared
        let apiKey = providerData.apiKey !== undefined && providerData.apiKey !== null ? String(providerData.apiKey).trim() : '';
        if (isUpdate && existing && !apiKey && !providerData.clearApiKey && providerData.apiKey !== null) {
            apiKey = existing.apiKey;
        }

        const models = Array.isArray(providerData.models) ? providerData.models.map(m => {
            const modelTimeout = parseInt(m.timeout, 10);
            return {
                id: String(m.id || '').trim(),
                label: String(m.label || m.id || '').trim(),
                enabled: m.enabled !== false,
                supportsThinking: m.supportsThinking !== undefined ? Boolean(m.supportsThinking) : isThinkingModel(m.id, m.label),
                ...(Number.isInteger(modelTimeout) && modelTimeout > 0 ? { timeout: modelTimeout } : {})
            };
        }).filter(m => m.id.length > 0) : [];

        const providerTimeout = parseInt(providerData.timeout, 10);
        const cleanProvider = {
            id,
            name: String(providerData.name || id).trim(),
            type: providerData.type === 'anthropic' ? 'anthropic' : 'openai',
            endpoint: String(providerData.endpoint || '').trim().replace(/\/+$/, ''),
            apiKey,
            enabled: providerData.enabled !== false,
            ...(Number.isInteger(providerTimeout) && providerTimeout > 0 ? { timeout: providerTimeout } : {}),
            models
        };

        if (isUpdate) {
            const idx = config.providers.findIndex(p => p.id === id);
            config.providers[idx] = cleanProvider;
        } else {
            config.providers.push(cleanProvider);
        }

        // Enable global toggle if at least one provider is enabled
        config.enabled = this._calculateEnabled(config.providers);

        this.saveConfig(config);
        return cleanProvider;
    }

    /**
     * Deletes a provider by ID.
     */
    deleteProvider(id) {
        const config = this.getConfig();
        const initialLen = config.providers.length;
        config.providers = config.providers.filter(p => p.id !== id);
        if (config.providers.length !== initialLen) {
            config.enabled = this._calculateEnabled(config.providers);
            this.saveConfig(config);
            return true;
        }
        return false;
    }

    /**
     * Checks whether any custom models are currently enabled.
     */
    hasEnabledModels() {
        const config = this.getConfig();
        if (!config.enabled) return false;
        return this._calculateEnabled(config.providers);
    }

    /**
     * Maps a model ID to a valid protobuf enum string in the MODEL_PLACEHOLDER_M500..M649 range.
     */
    getPlaceholderEnum(modelId, usedEnums = new Set()) {
        if (usedEnums.size >= PLACEHOLDER_COUNT) {
            throw new Error(`Maximum custom models capacity (${PLACEHOLDER_COUNT}) reached`);
        }
        let hash = 0;
        for (let i = 0; i < modelId.length; i++) {
            hash = ((hash << 5) - hash) + modelId.charCodeAt(i);
            hash |= 0;
        }
        let offset = PLACEHOLDER_START + (Math.abs(hash) % PLACEHOLDER_COUNT);
        let iterations = 0;
        while (usedEnums.has(`MODEL_PLACEHOLDER_M${offset}`) && iterations < PLACEHOLDER_COUNT) {
            offset = PLACEHOLDER_START + ((offset - PLACEHOLDER_START + 1) % PLACEHOLDER_COUNT);
            iterations++;
        }
        const enumName = `MODEL_PLACEHOLDER_M${offset}`;
        usedEnums.add(enumName);
        return enumName;
    }


    /**
     * Looks up an enabled model definition by its assigned placeholder enum,
     * returning complete provider credentials for server-side translation.
     */
    getModelByPlaceholder(placeholderEnum) {
        if (!placeholderEnum || typeof placeholderEnum !== 'string') return null;
        const cleanEnum = placeholderEnum.replace(/^.*models\//, '');
        const config = this.getConfig();
        const usedEnums = new Set();
        for (const provider of config.providers) {
            if (!provider.enabled) continue;
            for (const model of provider.models) {
                if (!model.enabled) continue;
                for (const v of getModelVariants(model)) {
                    const variantModelId = `custom-${provider.type}-${model.id}${v.variantSuffix}`;
                    const enumName = this.getPlaceholderEnum(variantModelId, usedEnums);
                    if (enumName === cleanEnum || variantModelId === cleanEnum || model.id === cleanEnum) {
                        return {
                            label: v.label,
                            modelId: variantModelId,
                            placeholder: enumName,
                            providerType: provider.type,
                            endpoint: provider.endpoint,
                            apiKey: provider.apiKey,
                            rawModelId: model.id,
                            supportsThinking: v.supportsThinking,
                            ...(typeof provider.timeout === 'number' && provider.timeout > 0 ? { timeout: provider.timeout } : {}),
                            ...(typeof model.timeout === 'number' && model.timeout > 0 ? { timeout: model.timeout } : {}),
                            ...(v.supportsThinking ? { thinkingLevel: v.thinkingLevel, thinkingBudget: v.thinkingBudget } : {})
                        };
                    }
                }
            }
        }
        return null;
    }

    /**
     * Formats all enabled custom models into Antigravity clientModelConfigs entries.
     * Note: Does NOT include API keys or internal credentials to prevent leakage to client browsers.
     */
    getInjectedModels(existingEnums = null) {
        const config = this.getConfig();
        const results = [];
        const usedEnums = new Set(existingEnums || []);

        for (const provider of config.providers) {
            if (!provider.enabled) continue;

            const providerTag = String(provider.name || '').trim() || (provider.type === 'anthropic' ? 'Anthropic' : 'OpenAI');
            for (const model of provider.models) {
                if (!model.enabled) continue;

                for (const v of getModelVariants(model)) {
                    const variantModelId = `custom-${provider.type}-${model.id}${v.variantSuffix}`;
                    const placeholderEnum = this.getPlaceholderEnum(variantModelId, usedEnums);
                    results.push({
                        label: v.label,
                        modelOrAlias: { model: placeholderEnum },
                        supportsImages: true,
                        supportsThinking: v.supportsThinking,
                        ...(v.supportsThinking ? { thinkingLevel: v.thinkingLevel, thinkingBudget: v.thinkingBudget } : {}),
                        isRecommended: true,
                        allowedTiers: DEFAULT_ALLOWED_TIERS,
                        quotaInfo: {
                            remainingFraction: 1.0,
                            resetTime: new Date(Date.now() + 86400000).toISOString()
                        },
                        tagTitle: providerTag,
                        tagDescription: providerTag,
                        supportedMimeTypes: DEFAULT_SUPPORTED_MIME_TYPES,
                        modelId: variantModelId
                    });
                }
            }
        }
        return results;
    }

    /**
     * Checks whether an enum string belongs to the custom placeholder range (MODEL_PLACEHOLDER_M500..M649).
     */
    isCustomPlaceholder(placeholderEnum) {
        return isCustomPlaceholder(placeholderEnum);
    }

    /**
     * Tests connectivity to an Anthropic or OpenAI-compatible endpoint.
     */
    async testProvider(providerConfig) {
        const { type, endpoint } = providerConfig;
        if (!endpoint) throw new Error('Endpoint URL is required');

        let apiKey = providerConfig.apiKey !== undefined && providerConfig.apiKey !== null ? String(providerConfig.apiKey).trim() : '';
        if (!apiKey && providerConfig.id) {
            const existing = this.getProvider(providerConfig.id);
            if (existing && existing.apiKey) {
                apiKey = existing.apiKey;
            }
        }

        const isAnthropic = type === 'anthropic';
        let cleanBase = endpoint.trim().replace(/\/+$/, '');
        let targetUrl;

        if (isAnthropic) {
            cleanBase = cleanBase.replace(/\/+(v1(\/(messages|models))?)?$/, '');
            targetUrl = `${cleanBase}/v1/models`;
        } else {
            cleanBase = cleanBase.replace(/\/+(v1(\/(chat\/completions|models))?)?$/, '');
            targetUrl = `${cleanBase}/v1/models`;
        }

        const parsed = new URL(targetUrl);
        const headers = {
            'User-Agent': 'Antigravity-Models-Manager/1.0',
            'Accept': 'application/json'
        };

        if (isAnthropic) {
            if (apiKey) headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
        } else {
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const transport = parsed.protocol === 'https:' ? https : http;

        return new Promise((resolve) => {
            const MAX_BYTES = 2 * 1024 * 1024;
            let byteCount = 0;
            let resolved = false;

            const req = transport.request(parsed, { method: 'GET', headers, timeout: 10000 }, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    byteCount += chunk.length;
                    if (byteCount > MAX_BYTES) {
                        if (!resolved) {
                            resolved = true;
                            req.destroy();
                            resolve({ success: false, error: 'Response exceeded maximum limit of 2MB' });
                        }
                        return;
                    }
                    data += chunk;
                });
                res.on('end', () => {
                    if (resolved) return;
                    resolved = true;
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const parsedData = JSON.parse(data);
                            const rawModels = Array.isArray(parsedData.data)
                                ? parsedData.data
                                : (Array.isArray(parsedData.models) ? parsedData.models : []);
                            const models = rawModels
                                .filter(m => m && typeof m === 'object')
                                .map(m => ({
                                    id: String(m.id || m.name || m.model || ''),
                                    label: String(m.display_name || m.name || m.id || m.model || ''),
                                    supportsThinking: extractSupportsThinking(m, type)
                                }))
                                .filter(m => m.id.length > 0);
                            resolve({ success: true, models, status: res.statusCode });
                        } catch (e) {
                            resolve({ success: true, models: [], status: res.statusCode, raw: data });
                        }
                    } else {
                        resolve({
                            success: false,
                            status: res.statusCode,
                            error: `Server responded with status ${res.statusCode}: ${data.slice(0, 200)}`
                        });
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({ success: false, error: 'Connection timed out after 10 seconds' });
            });

            req.on('error', (err) => {
                resolve({ success: false, error: err.message });
            });

            req.end();
        });
    }
}

const defaultManager = new ModelsManager();

module.exports = {
    ModelsManager,
    defaultManager,
    maskApiKey,
    isCustomPlaceholder,
    matchCustomPlaceholders,
    CUSTOM_PLACEHOLDER_REGEX,
    CUSTOM_PLACEHOLDER_REGEX_GLOBAL,
    THINKING_LEVELS,
    THINKING_BUDGETS,
    EFFORT_REGEX,
    getModelVariants,
    isThinkingModel,
    THINKING_MODEL_REGEX,
    extractSupportsThinking
};
