'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { THINKING_BUDGETS } = require('./models-manager');

function isValidConversationId(id) {
    return typeof id === 'string' && id.length > 0 && id.length < 128 && !id.includes('/') && !id.includes('\\') && !id.includes('..') && /^[a-zA-Z0-9_-]+$/.test(id);
}

function checkConversationForCallIds(candId, callIds, brainDir, rootDir) {
    if (!candId || !Array.isArray(callIds) || callIds.length === 0) return false;

    // Check transcript.jsonl first (lightweight text file)
    const transcriptPath = path.join(brainDir, candId, '.system_generated', 'logs', 'transcript.jsonl');
    try {
        const stat = fs.statSync(transcriptPath);
        if (stat.size < 5 * 1024 * 1024) {
            const text = fs.readFileSync(transcriptPath, 'utf8');
            if (callIds.some(cid => text.includes(cid))) {
                return true;
            }
        }
    } catch {}

    // Query conversation SQLite DB
    const candDbPath = path.join(rootDir, 'conversations', `${candId}.db`);
    try {
        let Database;
        try {
            Database = require('bun:sqlite').Database;
        } catch {
            try { Database = require('node:sqlite').DatabaseSync; } catch {}
        }
        if (Database) {
            const db = new Database(candDbPath, { readonly: true });
            try {
                const queryFn = db.query ? (sql) => db.query(sql).all() : (sql) => db.prepare(sql).all();
                const rows = queryFn('SELECT metadata FROM steps WHERE step_type = 132');
                for (const row of rows) {
                    const meta = row?.metadata;
                    const metaStr = Buffer.isBuffer(meta)
                        ? meta.toString('utf8')
                        : (meta instanceof Uint8Array ? Buffer.from(meta).toString('utf8') : String(meta || ''));
                    if (callIds.some(cid => metaStr.includes(cid))) {
                        return true;
                    }
                }
            } finally {
                if (db.close) db.close();
            }
        } else {
            const stat = fs.statSync(candDbPath);
            if (stat.size < 2 * 1024 * 1024) {
                const content = fs.readFileSync(candDbPath, 'utf8');
                if (callIds.some(cid => content.includes(cid))) {
                    return true;
                }
            }
        }
    } catch {}

    return false;
}

/**
 * Reads the authentic tool outputs from the local conversation trajectory and database.
 * Antigravity (agy) records full tool output into transcript_full.jsonl / transcript.jsonl
 * and conversation step metadata into SQLite (~/.gemini/antigravity-cli/conversations/<convoId>.db).
 */
function resolveConversationToolOutputs(convoId, cascadeId, baseDir, options = {}) {
    const rootDir = baseDir || path.join(process.env.HOME || '/home/developer', '.gemini/antigravity-cli');
    const brainDir = path.join(rootDir, 'brain');
    let targetConvoId = convoId;

    if (!targetConvoId || !fs.existsSync(path.join(brainDir, targetConvoId))) {
        if (cascadeId && fs.existsSync(path.join(brainDir, cascadeId))) {
            targetConvoId = cascadeId;
        } else {
            targetConvoId = null;
        }
    }

    // Auto-discovery kicks in only if no specific convoId/cascadeId was requested (to avoid cross-pollution)
    const hasExplicitRequestedId = Boolean(convoId || cascadeId);
    if (!targetConvoId && !hasExplicitRequestedId) {
        const validCandidates = (options.candidateIds || [])
            .filter(cid => isValidConversationId(cid) && fs.existsSync(path.join(brainDir, cid)));

        // 1. If call IDs are provided, test candidate IDs first (instant check, avoids scanning 500+ directories!)
        if (Array.isArray(options.callIds) && options.callIds.length > 0) {
            for (const candId of validCandidates) {
                if (checkConversationForCallIds(candId, options.callIds, brainDir, rootDir)) {
                    targetConvoId = candId;
                    break;
                }
            }
        }

        // 2. If still not matched, scan recent conversations from brainDir
        let sorted = null;
        if (!targetConvoId && fs.existsSync(brainDir)) {
            try {
                const entries = fs.readdirSync(brainDir, { withFileTypes: true });
                sorted = entries
                    .filter(e => e.isDirectory() && !e.name.startsWith('.') && isValidConversationId(e.name))
                    .map(e => {
                        try {
                            const dirPath = path.join(brainDir, e.name);
                            let mtime = 0;
                            const dbPath = path.join(rootDir, 'conversations', `${e.name}.db`);
                            try {
                                mtime = fs.statSync(dbPath).mtimeMs;
                            } catch {}
                            const transcriptPath = path.join(dirPath, '.system_generated', 'logs', 'transcript.jsonl');
                            try {
                                mtime = Math.max(mtime, fs.statSync(transcriptPath).mtimeMs);
                            } catch {}
                            if (mtime === 0) {
                                mtime = fs.statSync(dirPath).mtimeMs;
                            }
                            return { name: e.name, mtime };
                        } catch {
                            return null;
                        }
                    })
                    .filter(Boolean)
                    .sort((a, b) => b.mtime - a.mtime);
            } catch {}
        }

        // 3. Search recent conversations if call IDs are provided and candidates did not match
        if (!targetConvoId && Array.isArray(options.callIds) && options.callIds.length > 0 && Array.isArray(sorted)) {
            for (const item of sorted.slice(0, 30)) {
                if (validCandidates.includes(item.name)) continue;
                if (checkConversationForCallIds(item.name, options.callIds, brainDir, rootDir)) {
                    targetConvoId = item.name;
                    break;
                }
            }
        }

        // 4. Fall back to candidate IDs (sorted by recency if multiple)
        if (!targetConvoId && validCandidates.length > 0) {
            if (validCandidates.length === 1) {
                targetConvoId = validCandidates[0];
            } else if (Array.isArray(sorted)) {
                for (const item of sorted) {
                    if (validCandidates.includes(item.name)) {
                        targetConvoId = item.name;
                        break;
                    }
                }
                if (!targetConvoId) targetConvoId = validCandidates[0];
            } else {
                targetConvoId = validCandidates[0];
            }
        }

        // 5. Fall back to the most recently modified conversation in brainDir
        if (!targetConvoId && Array.isArray(sorted) && sorted.length > 0) {
            targetConvoId = sorted[0].name;
        }
    }

    const outputsByCallId = new Map();
    const outputsByToolName = new Map();
    const stepIndexToCallId = new Map();
    const stepIndexToToolName = new Map();

    if (!targetConvoId) {
        return { targetConvoId: null, outputsByCallId, outputsByToolName };
    }

    // 1. Try SQLite mapping if DB exists
    const dbPath = path.join(rootDir, 'conversations', `${targetConvoId}.db`);
    if (fs.existsSync(dbPath)) {
        try {
            let Database;
            try {
                Database = require('bun:sqlite').Database;
            } catch {
                try { Database = require('node:sqlite').DatabaseSync; } catch {}
            }
            if (Database) {
                const db = new Database(dbPath, { readonly: true });
                try {
                    const queryFn = db.query ? (sql) => db.query(sql).all() : (sql) => db.prepare(sql).all();
                    const rows = queryFn('SELECT idx, metadata FROM steps WHERE step_type = 132');
                    for (const row of rows) {
                        if (!row || row.idx === undefined) continue;
                        const buf = Buffer.isBuffer(row.metadata)
                            ? row.metadata
                            : (row.metadata instanceof Uint8Array ? Buffer.from(row.metadata) : Buffer.from(String(row.metadata || '')));
                        const rawStr = buf.toString('utf8');
                        const callMatch = rawStr.match(/(?:call|toolu)_[a-zA-Z0-9_-]+/);
                        if (callMatch) {
                            const callId = callMatch[0];
                            stepIndexToCallId.set(row.idx, callId);

                            const callIdx = buf.indexOf(callId);
                            if (callIdx !== -1) {
                                const afterCallIdx = callIdx + callId.length;
                                // In protobuf, field 2 (tag 0x12) is string tool_name: [0x12, length, ...nameBytes]
                                if (afterCallIdx < buf.length && buf[afterCallIdx] === 0x12) {
                                    const nameLen = buf[afterCallIdx + 1];
                                    if (nameLen > 0 && afterCallIdx + 2 + nameLen <= buf.length) {
                                        const toolName = buf.slice(afterCallIdx + 2, afterCallIdx + 2 + nameLen).toString('utf8');
                                        if (/^[a-zA-Z0-9_.-]+$/.test(toolName)) {
                                            stepIndexToToolName.set(row.idx, toolName);
                                        }
                                    }
                                }
                            }
                        }
                    }
                } finally {
                    if (typeof db.close === 'function') db.close();
                }
            }
        } catch {}
    }

    // 2. Read transcript
    const convoBrainDir = path.join(brainDir, targetConvoId);
    const transcriptFull = path.join(convoBrainDir, '.system_generated', 'logs', 'transcript_full.jsonl');
    const transcriptCompact = path.join(convoBrainDir, '.system_generated', 'logs', 'transcript.jsonl');
    const transcriptFile = fs.existsSync(transcriptFull) ? transcriptFull : (fs.existsSync(transcriptCompact) ? transcriptCompact : null);

    if (transcriptFile) {
        try {
            const content = fs.readFileSync(transcriptFile, 'utf8');
            const lines = content.split('\n');
            const pendingToolCalls = [];

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                let parsed;
                try {
                    parsed = JSON.parse(trimmed);
                } catch { continue; }

                if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
                    for (const tc of parsed.tool_calls) {
                        pendingToolCalls.push({
                            name: tc.name,
                            stepIndex: parsed.step_index
                        });
                    }
                }

                // Explicitly ignore user prompts and assistant/planner responses
                if (parsed.type === 'USER_INPUT' || parsed.type === 'PLANNER_RESPONSE') {
                    continue;
                }

                if (parsed.content && typeof parsed.content === 'string') {
                    const stepIdx = parsed.step_index;
                    let matchedCallId = stepIndexToCallId.get(stepIdx);
                    let matchedToolName = stepIndexToToolName.get(stepIdx);

                    if (!matchedToolName && pendingToolCalls.length > 0) {
                        const nextCall = pendingToolCalls.shift();
                        matchedToolName = nextCall.name;
                    }

                    // Check steps/<idx>/output.txt as authoritative file if present
                    let finalOutput = parsed.content;
                    const stepOutputFile = path.join(convoBrainDir, '.system_generated', 'steps', String(stepIdx), 'output.txt');
                    if (fs.existsSync(stepOutputFile)) {
                        try {
                            const diskOutput = fs.readFileSync(stepOutputFile, 'utf8');
                            if (diskOutput.trim()) finalOutput = diskOutput;
                        } catch {}
                    }

                    if (matchedCallId) {
                        outputsByCallId.set(matchedCallId, finalOutput);
                    }
                    if (matchedToolName) {
                        if (!outputsByToolName.has(matchedToolName)) {
                            outputsByToolName.set(matchedToolName, []);
                        }
                        outputsByToolName.get(matchedToolName).push(finalOutput);
                    }
                }
            }
        } catch {}
    }

    // 3. For any stepIndex mapped in SQLite that hasn't been resolved yet, check steps/<idx>/output.txt
    for (const [stepIdx, callId] of stepIndexToCallId) {
        if (!outputsByCallId.has(callId)) {
            const stepOutputFile = path.join(convoBrainDir, '.system_generated', 'steps', String(stepIdx), 'output.txt');
            if (fs.existsSync(stepOutputFile)) {
                try {
                    const diskOutput = fs.readFileSync(stepOutputFile, 'utf8');
                    if (diskOutput.trim()) {
                        outputsByCallId.set(callId, diskOutput);
                        const toolName = stepIndexToToolName.get(stepIdx);
                        if (toolName) {
                            if (!outputsByToolName.has(toolName)) {
                                outputsByToolName.set(toolName, []);
                            }
                            outputsByToolName.get(toolName).push(diskOutput);
                        }
                    }
                } catch {}
            }
        }
    }

    return { targetConvoId, outputsByCallId, outputsByToolName };
}

/**
 * Creates a resolver function that matches tool calls by callId first, then falls back
 * to FIFO order for matching tool names.
 */
function createToolOutputResolver(toolOutputs) {
    if (!toolOutputs) return () => null;
    if (typeof toolOutputs === 'function') return toolOutputs;

    const outputsByCallId = toolOutputs.outputsByCallId instanceof Map
        ? toolOutputs.outputsByCallId
        : new Map(Object.entries(toolOutputs.outputsByCallId || {}));

    const outputsByToolName = new Map();
    if (toolOutputs.outputsByToolName instanceof Map) {
        for (const [k, v] of toolOutputs.outputsByToolName) {
            outputsByToolName.set(k, Array.isArray(v) ? [...v] : [v]);
        }
    } else if (toolOutputs.outputsByToolName && typeof toolOutputs.outputsByToolName === 'object') {
        for (const [k, v] of Object.entries(toolOutputs.outputsByToolName)) {
            outputsByToolName.set(k, Array.isArray(v) ? [...v] : [v]);
        }
    }

    return (callId, toolName) => {
        if (callId && outputsByCallId.has(callId)) {
            return outputsByCallId.get(callId);
        }
        if (toolName && outputsByToolName.has(toolName)) {
            const queue = outputsByToolName.get(toolName);
            if (queue && queue.length > 0) {
                return queue.shift();
            }
        }
        return null;
    };
}

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

const INTEGER_TOOL_KEYS = new Set([
    'StartLine', 'EndLine', 'ContentOffset', 'DurationSeconds',
    'MaxIterations', 'WaitMsBeforeAsync', 'MaxDepth'
]);

function isArtifactPath(target) {
    if (typeof target !== 'string') return false;
    return target.includes('/.gemini/antigravity-cli/brain/') ||
           target.includes('/antigravity-cli/brain/');
}

/**
 * Sanitizes and normalizes tool call arguments to guarantee compatibility with Antigravity (agy).
 * Specifically:
 * - write_to_file: agy strictly validates artifact paths and rejects calls with:
 *   "ArtifactMetadata was provided but %s is not a valid artifact path; artifacts must be in %s/"
 *   If TargetFile is outside the brain/artifacts directory, ArtifactMetadata MUST NOT be provided.
 *   Conversely, if TargetFile is in the artifact directory, ArtifactMetadata MUST be provided.
 * - Coerces string booleans ("true"/"false") and string numbers ("10") to native JSON booleans and numbers.
 */
function sanitizeToolCallArgs(name, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
    const cleanArgs = { ...args };

    for (const [key, val] of Object.entries(cleanArgs)) {
        if (typeof val === 'string') {
            if (val.length <= 5) {
                const lower = val.trim().toLowerCase();
                if (lower === 'true') {
                    cleanArgs[key] = true;
                    continue;
                }
                if (lower === 'false') {
                    cleanArgs[key] = false;
                    continue;
                }
            }
            if (INTEGER_TOOL_KEYS.has(key)) {
                const trimmed = val.trim();
                if (/^-?\d+$/.test(trimmed)) {
                    cleanArgs[key] = parseInt(trimmed, 10);
                }
            }
        }
    }

    if (name === 'write_to_file') {
        const target = cleanArgs.TargetFile || cleanArgs.targetFile || cleanArgs.target_file;
        if (!isArtifactPath(target)) {
            for (const k of Object.keys(cleanArgs)) {
                if (/^artifact_?metadata$/i.test(k)) {
                    delete cleanArgs[k];
                }
            }
            // Always set Overwrite to true for non-artifact paths (coercing undefined, false, or 'false' to true),
            // so custom models don't fail with "file already exists" on repeat writes.
            cleanArgs.Overwrite = true;
            delete cleanArgs.overwrite;
        } else {
            let meta = cleanArgs.ArtifactMetadata || cleanArgs.artifactMetadata || cleanArgs.artifact_metadata;
            if (typeof meta === 'string') {
                try { meta = JSON.parse(meta); } catch {}
            }
            cleanArgs.ArtifactMetadata = (meta && typeof meta === 'object') ? meta : {
                RequestFeedback: false,
                Summary: cleanArgs.Description || 'Artifact document',
                UserFacing: false
            };
        }
    }

    return cleanArgs;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (600,000 ms)

function getRequestTimeout(options = {}) {
    const optTimeout = typeof options.timeout === 'string' ? parseInt(options.timeout, 10) : options.timeout;
    if (typeof optTimeout === 'number' && !isNaN(optTimeout) && optTimeout > 0) {
        return optTimeout;
    }
    const envMs = parseInt(process.env.CUSTOM_MODEL_TIMEOUT_MS || '', 10);
    if (!isNaN(envMs) && envMs > 0) return envMs;
    const envSecs = parseInt(process.env.CUSTOM_MODEL_TIMEOUT_SECONDS || '', 10);
    if (!isNaN(envSecs) && envSecs > 0) return envSecs * 1000;
    return DEFAULT_REQUEST_TIMEOUT_MS;
}

function formatTimeoutError(providerName, timeoutMs) {
    if (timeoutMs < 1000) {
        return `${providerName} request timed out after ${timeoutMs}ms`;
    }
    if (timeoutMs % 60000 === 0) {
        const mins = timeoutMs / 60000;
        return `${providerName} request timed out after ${mins} minute${mins === 1 ? '' : 's'}`;
    }
    const secs = Math.round(timeoutMs / 1000);
    return `${providerName} request timed out after ${secs} second${secs === 1 ? '' : 's'}`;
}

const EMPTY_COMPLETION_FALLBACK_TEXT = 'Model completed without returning any output text or tool calls.';

function createSettledPromise() {
    let isSettled = false;
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
    });
    return {
        promise,
        safeResolve: (val) => {
            if (!isSettled) {
                isSettled = true;
                resolveFn(val);
            }
        },
        safeReject: (err) => {
            if (!isSettled) {
                isSettled = true;
                rejectFn(err);
            }
        }
    };
}

/**
 * Streams chat completion from an Anthropic Messages endpoint and normalizes events.
 */
function callAnthropicStream(options) {
    const requestTimeout = getRequestTimeout(options);
    const {
        endpoint,
        apiKey,
        model,
        messages,
        system,
        tools,
        supportsThinking,
        useAdaptiveThinking: forceAdaptive,
        maxTokens = 8192,
        signal,
        onEvent
    } = options;

    let cleanBase = (endpoint || 'https://api.anthropic.com').trim().replace(/\/+$/, '');
    cleanBase = cleanBase.replace(/\/+(v1(\/(messages|models))?)?$/, '');
    const targetUrl = `${cleanBase}/v1/messages`;

    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === 'https:' ? https : http;

    const useAdaptiveThinking = options.useAdaptiveThinking ||
        options.thinkingType === 'adaptive' ||
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
            const level = (options.thinkingLevel || options.effort || '').toLowerCase();
            const budgetTokens = options.thinkingBudget || options.budgetTokens || (THINKING_BUDGETS && THINKING_BUDGETS[level]) || 2048;
            payload.thinking = { type: 'enabled', budget_tokens: budgetTokens };
            payload.max_tokens = Math.max(maxTokens, budgetTokens + 4096);
        }
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

    const { promise, safeResolve, safeReject } = createSettledPromise();

    const req = transport.request(parsed, { method: 'POST', headers, timeout: requestTimeout }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
            let errBody = '';
            res.on('data', chunk => errBody += chunk);
            res.on('end', () => {
                if (res.statusCode === 400 && supportsThinking && !options._thinkingRetried) {
                    if (errBody.includes('thinking.type.adaptive') && !useAdaptiveThinking) {
                        return safeResolve(callAnthropicStream({ ...options, thinkingType: 'adaptive', _thinkingRetried: true }));
                    }
                    if (errBody.includes('adaptive thinking is not supported') && useAdaptiveThinking) {
                        return safeResolve(callAnthropicStream({ ...options, thinkingType: 'enabled', _thinkingRetried: true }));
                    }
                }
                safeReject(new Error(`Anthropic error (${res.statusCode}): ${errBody}`));
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

                        if (evType === 'error' || data.type === 'error' || Boolean(data.error)) {
                            const errorObj = data.error;
                            const errMsg = (typeof errorObj === 'object' && errorObj !== null)
                                ? (errorObj.message || errorObj.type || JSON.stringify(errorObj))
                                : (typeof errorObj === 'string' ? errorObj : (data.message || 'Unknown Anthropic error'));
                            safeReject(new Error(`Anthropic error: ${errMsg}`));
                            req.destroy();
                            return;
                        }

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
                    } catch (e) {
                        if (currentEvent === 'error') {
                            safeReject(new Error(`Anthropic error: ${dataStr}`));
                            req.destroy();
                            return;
                        }
                    }
                }
            }
        });

        res.on('end', () => safeResolve());
        res.on('error', safeReject);
    });

    req.on('timeout', () => {
        safeReject(new Error(formatTimeoutError('Anthropic', requestTimeout)));
        req.destroy();
    });
    req.on('error', safeReject);

    if (options.signal) {
        if (options.signal.aborted) {
            safeReject(new Error('Aborted by client'));
            req.destroy();
        } else {
            options.signal.addEventListener('abort', () => {
                safeReject(new Error('Aborted by client'));
                req.destroy();
            });
        }
    }

    req.write(body);
    req.end();
    return promise;
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
 * Determines whether text content represents a tool execution response (stdout, file content,
 * structured execution summaries, etc.) rather than an interactive user prompt.
 */
function isToolExecutionOutput(text, candCallId, pendingCalls) {
    if (candCallId && Array.isArray(pendingCalls) && pendingCalls.some(c => (c.id || c.callId) === candCallId)) {
        return true;
    }
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (trimmed.startsWith('<USER_REQUEST>') || trimmed.startsWith('<SYSTEM_MESSAGE>')) {
        return false;
    }
    if (trimmed.startsWith('Created At:') || trimmed.startsWith('Completed At:') ||
        trimmed.startsWith('File Path:') || trimmed.startsWith('Output:') ||
        trimmed.startsWith('The command exited') || trimmed.startsWith('Exit code:') ||
        trimmed.startsWith('Launched ') || trimmed.startsWith('Direct Subagents:') ||
        trimmed.startsWith('Total results:') || trimmed.startsWith('Matches:') ||
        trimmed.startsWith('Created file ') ||
        trimmed.startsWith('Created the following subagents:') ||
        trimmed.startsWith('Message sent to ') ||
        trimmed.startsWith('Total Lines:') ||
        trimmed.startsWith('Showing lines ') ||
        trimmed.startsWith('Error:') ||
        trimmed.startsWith('Command failed') ||
        trimmed.includes('active subagent(s):') ||
        trimmed.includes('[diff_block_start]') ||
        trimmed.includes('The following changes were made by the') ||
        trimmed.includes('The command exited with code') ||
        trimmed.includes('with requested content.')) {
        return true;
    }
    return false;
}

/**
 * Converts standard ChatML messages to OpenAI Responses API input items.
 */
function chatMessagesToResponsesInput(messages) {
    if (!Array.isArray(messages)) return [];
    const input = [];

    let i = 0;
    while (i < messages.length) {
        const m = messages[i];
        if (!m) {
            i++;
            continue;
        }

        if (m.role === 'system') {
            if (m.content) {
                input.push({ role: 'system', content: String(m.content) });
            }
            i++;
        } else if (m.role === 'assistant') {
            if (m.content) {
                input.push({ role: 'assistant', content: String(m.content) });
            }
            if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                const callList = [];
                for (const tc of m.tool_calls) {
                    const fnName = tc.function?.name || tc.name || '';
                    const fnArgs = typeof tc.function?.arguments === 'string'
                        ? tc.function.arguments
                        : JSON.stringify(tc.function?.arguments || {});
                    const callId = tc.id || `call_${crypto.randomUUID().slice(0, 8)}`;
                    callList.push({ callId, fnName, fnArgs });
                    input.push({
                        type: 'function_call',
                        call_id: callId,
                        name: fnName,
                        arguments: fnArgs
                    });
                }

                // Look ahead in subsequent messages to find tool responses matching these calls
                // before the next assistant turn.
                let nextIdx = i + 1;
                const toolOutputsMap = new Map();
                const consumedIndices = new Set();
                const fifoPendingCalls = [...callList];

                while (nextIdx < messages.length && messages[nextIdx]?.role !== 'assistant') {
                    const cand = messages[nextIdx];
                    if (cand?.role === 'tool') {
                        consumedIndices.add(nextIdx);
                        const candCallId = cand.tool_call_id;
                        let matchedCallId = null;

                        const callMatch = fifoPendingCalls.find(c => c.callId === candCallId);
                        if (callMatch) {
                            matchedCallId = callMatch.callId;
                            const idx = fifoPendingCalls.indexOf(callMatch);
                            if (idx !== -1) fifoPendingCalls.splice(idx, 1);
                        } else if (fifoPendingCalls.length > 0) {
                            matchedCallId = fifoPendingCalls.shift().callId;
                        } else {
                            matchedCallId = candCallId || 'call_unknown';
                        }

                        let outStr = typeof cand.content === 'string'
                            ? cand.content
                            : JSON.stringify(cand.content !== undefined ? cand.content : {});
                        if (isEffectivelyEmpty(outStr)) {
                            const matchedCall = callList.find(c => c.callId === matchedCallId);
                            outStr = formatToolSuccessFallback(matchedCall?.fnName);
                        }
                        toolOutputsMap.set(matchedCallId, outStr);
                    } else if (cand?.role === 'user' && fifoPendingCalls.length > 0) {
                        const candText = typeof cand.content === 'string'
                            ? cand.content
                            : Array.isArray(cand.content)
                                ? cand.content.map(c => typeof c === 'string' ? c : (c?.text || '')).filter(Boolean).join('\n')
                                : '';
                        const candCallId = cand.tool_call_id || cand.id;
                        if (isToolExecutionOutput(candText, candCallId, fifoPendingCalls)) {
                            consumedIndices.add(nextIdx);
                            const callMatch = candCallId ? fifoPendingCalls.find(c => (c.id || c.callId) === candCallId) : null;
                            let matchedCall;
                            if (callMatch) {
                                matchedCall = callMatch;
                                const idx = fifoPendingCalls.indexOf(callMatch);
                                if (idx !== -1) fifoPendingCalls.splice(idx, 1);
                            } else {
                                matchedCall = fifoPendingCalls.shift();
                            }
                            let outStr = candText;
                            if (isEffectivelyEmpty(outStr)) {
                                outStr = formatToolSuccessFallback(matchedCall.fnName);
                            }
                            toolOutputsMap.set(matchedCall.callId, outStr);
                        }
                    }
                    nextIdx++;
                }

                for (const c of callList) {
                    let output = toolOutputsMap.has(c.callId)
                        ? toolOutputsMap.get(c.callId)
                        : null;
                    if (isEffectivelyEmpty(output)) {
                        output = formatToolSuccessFallback(c.fnName);
                    }
                    input.push({
                        type: 'function_call_output',
                        call_id: c.callId,
                        output
                    });
                }

                i++;
                while (i < nextIdx) {
                    if (!consumedIndices.has(i)) {
                        const nonToolMsg = messages[i];
                        if (nonToolMsg) {
                            if (nonToolMsg.role === 'system' && nonToolMsg.content) {
                                input.push({ role: 'system', content: String(nonToolMsg.content) });
                            } else if (nonToolMsg.role === 'user') {
                                input.push({ role: 'user', content: nonToolMsg.content });
                            }
                        }
                    }
                    i++;
                }
            } else {
                i++;
            }
        } else if (m.role === 'user') {
            input.push({ role: 'user', content: m.content });
            i++;
        } else if (m.role === 'tool') {
            let output = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || {});
            if (isEffectivelyEmpty(output)) {
                output = 'Tool executed successfully.';
            }
            input.push({
                type: 'function_call_output',
                call_id: m.tool_call_id || 'call_unknown',
                output
            });
            i++;
        } else {
            i++;
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
    const requestTimeout = getRequestTimeout(options);
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
    const level = (options.thinkingLevel || '').toLowerCase();
    if (options.supportsThinking && ['low', 'medium', 'high'].includes(level)) {
        payload.reasoning = { effort: level };
    }

    const body = JSON.stringify(payload);
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const { promise, safeResolve, safeReject } = createSettledPromise();

    const req = transport.request(parsed, { method: 'POST', headers, timeout: requestTimeout }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
            let errBody = '';
            res.on('data', chunk => errBody += chunk);
            res.on('end', () => {
                if (res.statusCode === 404 && !options._chatCompletionsRetried) {
                    return safeResolve(callOpenAIStream({ ...options, _chatCompletionsRetried: true, forceChatCompletions: true }));
                }
                safeReject(new Error(`OpenAI Responses error (${res.statusCode}): ${errBody}`));
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

                        const isErrorEvent = evType === 'error' || data.type === 'error' ||
                                             evType === 'response.failed' || data.type === 'response.failed' ||
                                             Boolean(data.error || data.response?.error);

                        if (isErrorEvent) {
                            const errorObj = data.error || data.response?.error;
                            const errMsg = (typeof errorObj === 'object' && errorObj !== null)
                                ? (errorObj.message || errorObj.code || JSON.stringify(errorObj))
                                : (typeof errorObj === 'string' ? errorObj : (data.message || 'Unknown OpenAI error'));
                            safeReject(new Error(`OpenAI Responses error: ${errMsg}`));
                            req.destroy();
                            return;
                        }

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
                    } catch (e) {
                        if (currentEvent === 'error') {
                            safeReject(new Error(`OpenAI Responses error: ${dataStr}`));
                            req.destroy();
                            return;
                        }
                    }
                }
            }
        });

        res.on('end', () => {
            if (!hasCompleted) {
                hasCompleted = true;
                onEvent({ type: 'done' });
            }
            safeResolve();
        });
        res.on('error', safeReject);
    });

    req.on('timeout', () => {
        safeReject(new Error(formatTimeoutError('OpenAI Responses', requestTimeout)));
        req.destroy();
    });
    req.on('error', safeReject);

    if (options.signal) {
        if (options.signal.aborted) {
            safeReject(new Error('Aborted by client'));
            req.destroy();
        } else {
            options.signal.addEventListener('abort', () => {
                safeReject(new Error('Aborted by client'));
                req.destroy();
            });
        }
    }

    req.write(body);
    req.end();
    return promise;
}

/**
 * Streams chat completion from an OpenAI-compatible endpoint and normalizes events.
 */
function callOpenAIStream(options) {
    const requestTimeout = getRequestTimeout(options);
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
    if (maxTokens) payload.max_tokens = maxTokens;

    const level = (options.thinkingLevel || '').toLowerCase();
    if (options.supportsThinking && ['low', 'medium', 'high'].includes(level) && !options.omitReasoningEffort) {
        payload.reasoning_effort = level;
    }

    const body = JSON.stringify(payload);
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const { promise, safeResolve, safeReject } = createSettledPromise();

    const req = transport.request(parsed, { method: 'POST', headers, timeout: requestTimeout }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
            let errBody = '';
            res.on('data', chunk => errBody += chunk);
            res.on('end', () => {
                // Fall back to /v1/responses if chat completions indicates Responses API is required
                if (res.statusCode === 400 && errBody.includes('/v1/responses')) {
                    if (model) RESPONSES_API_MODELS.add(model.toLowerCase());
                    return safeResolve(callOpenAIResponsesStream(options));
                }
                // Retry without reasoning_effort if rejected by endpoint (HTTP 400 or 422)
                if ((res.statusCode === 400 || res.statusCode === 422) && errBody.includes('reasoning_effort') && !options._reasoningRetried) {
                    return safeResolve(callOpenAIStream({ ...options, _reasoningRetried: true, omitReasoningEffort: true }));
                }
                safeReject(new Error(`OpenAI error (${res.statusCode}): ${errBody}`));
            });
            return;
        }

        let buffer = '';
        let hasCompleted = false;
        let currentEvent = null;
        const pendingToolCalls = {}; // index -> { id, name, args }

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

                if (!trimmed.startsWith('data:')) continue;

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
                    const evType = currentEvent || data.type;

                    if (evType === 'error' || data.type === 'error' || Boolean(data.error)) {
                        const errorObj = data.error;
                        const errMsg = (typeof errorObj === 'object' && errorObj !== null)
                            ? (errorObj.message || errorObj.code || JSON.stringify(errorObj))
                            : (typeof errorObj === 'string' ? errorObj : (data.message || 'Unknown OpenAI error'));
                        safeReject(new Error(`OpenAI error: ${errMsg}`));
                        req.destroy();
                        return;
                    }

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
                } catch (e) {
                    if (currentEvent === 'error') {
                        safeReject(new Error(`OpenAI error: ${dataStr}`));
                        req.destroy();
                        return;
                    }
                }
            }
        });

        res.on('end', () => safeResolve());
        res.on('error', safeReject);
    });

    req.on('timeout', () => {
        safeReject(new Error(formatTimeoutError('OpenAI', requestTimeout)));
        req.destroy();
    });
    req.on('error', safeReject);

    if (options.signal) {
        if (options.signal.aborted) {
            safeReject(new Error('Aborted by client'));
            req.destroy();
        } else {
            options.signal.addEventListener('abort', () => {
                safeReject(new Error('Aborted by client'));
                req.destroy();
            });
        }
    }

    req.write(body);
    req.end();
    return promise;
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
        if (!toolGroup) continue;
        const decls = toolGroup.functionDeclarations || toolGroup.function_declarations || (toolGroup.name ? [toolGroup] : null);
        if (Array.isArray(decls)) {
            for (const fn of decls) {
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
        if (!toolGroup) continue;
        const decls = toolGroup.functionDeclarations || toolGroup.function_declarations || (toolGroup.name ? [toolGroup] : null);
        if (Array.isArray(decls)) {
            for (const fn of decls) {
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
            const prevHasToolUse = prev.role === 'assistant' && Array.isArray(prev.content) && prev.content.some(c => c.type === 'tool_use');
            if (prev.role === 'assistant' && prevHasToolUse) {
                coalesced.push({ role: 'user', content: [{ type: 'text', text: 'Proceed.' }] });
                coalesced.push({
                    role: msg.role,
                    content: Array.isArray(msg.content) ? [...msg.content] : [{ type: 'text', text: String(msg.content) }]
                });
            } else {
                const extra = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content) }];
                prev.content.push(...extra);
            }
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
 * Helper to safely extract function call details from a Gemini part, supporting camelCase and snake_case keys.
 */
function getFunctionCall(part) {
    if (!part || typeof part !== 'object') return null;
    const call = part.functionCall || part.function_call;
    if (!call || typeof call !== 'object') return null;
    return {
        name: call.name || '',
        args: call.args || call.arguments || {},
        id: call.id || call.call_id || call.callId || null
    };
}

/**
 * Helper to check if a value is effectively empty, including empty strings ('', '{}'),
 * empty objects ({}), and protobuf Struct representations ({ fields: {} }, { structValue: {} }).
 */
function isEffectivelyEmpty(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string') {
        const trimmed = v.trim();
        return trimmed === '' || /^\{\s*\}$/.test(trimmed);
    }
    if (typeof v === 'object' && !Array.isArray(v)) {
        const keys = Object.keys(v).filter(k => k !== 'parts');
        if (keys.length === 0) return true;
        if (keys.length === 1) {
            if (keys[0] === 'fields') {
                return isEffectivelyEmpty(v.fields);
            }
            if (keys[0] === 'structValue') {
                return isEffectivelyEmpty(v.structValue);
            }
        }
    }
    return false;
}

/**
 * Recursively unpacks protobuf Struct and Value wrappers (fields, stringValue, numberValue,
 * boolValue, listValue, structValue) into standard JavaScript objects, primitives, or strings.
 */
function unpackProtobufValue(val) {
    if (val === null || val === undefined || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(unpackProtobufValue);

    const keys = Object.keys(val);
    if (keys.length === 1) {
        const k = keys[0];
        if (k === 'stringValue') return val.stringValue;
        if (k === 'numberValue') return val.numberValue;
        if (k === 'boolValue') return val.boolValue;
        if (k === 'nullValue') return null;
        if (k === 'structValue') return unpackProtobufValue(val.structValue);
        if (k === 'listValue') {
            const list = Array.isArray(val.listValue?.values)
                ? val.listValue.values
                : (Array.isArray(val.listValue) ? val.listValue : []);
            return list.map(unpackProtobufValue);
        }
        if (k === 'fields' && typeof val.fields === 'object' && val.fields !== null && !Array.isArray(val.fields)) {
            const res = {};
            for (const [fk, fv] of Object.entries(val.fields)) {
                res[fk] = unpackProtobufValue(fv);
            }
            return res;
        }
    }

    // Standard object: recursively unpack child properties
    const res = {};
    for (const [k, v] of Object.entries(val)) {
        res[k] = unpackProtobufValue(v);
    }
    return res;
}

/**
 * Provides a sensible, human-readable confirmation string when a tool executes successfully
 * but returns an empty output or payload, preventing models from interpreting {} as a failure.
 */
function formatToolSuccessFallback(toolName) {
    if (!toolName || typeof toolName !== 'string') {
        return 'Tool executed successfully with no additional output.';
    }
    const name = toolName.toLowerCase();
    if (name.includes('write')) return 'File written successfully.';
    if (name.includes('edit') || name.includes('replace')) return 'File content updated successfully.';
    if (name.startsWith('save_memory') || name === 'record_memory') return 'Memory recorded successfully.';
    if (name.startsWith('lookup_memory') || name.startsWith('search_memory') || name.startsWith('find_memory')) {
        return 'No matching memories found.';
    }
    if (name.includes('memory')) return 'Memory operation completed successfully.';
    if (name.includes('subagent') || name.includes('agent')) return 'Subagent operation completed successfully.';
    if (name.includes('notify')) return 'Notification sent successfully.';
    if (name === 'read_url_content' || name.includes('fetch_url')) return 'Web page content is empty.';
    if (name.includes('url') || name.includes('browser') || name.includes('web')) {
        return 'Web content retrieved with no additional output.';
    }
    if (name === 'view_file' || name.startsWith('read_file')) return 'File read completed.';
    if (name.includes('list_dir') || name === 'list_directory') return 'Directory listing completed.';
    if (name.includes('search') || name.includes('grep') || name.includes('find')) return 'Search completed.';
    if (name.includes('run_command') || name.includes('execute')) return 'Command executed.';
    return 'Tool executed successfully with no additional output.';
}


/**
 * Safely extracts the response payload from a function response or part,
 * resolving nested parts (including base64 decoded data), output fields, and error details.
 */
function extractResponseValue(resp, part, fallbackToolName) {
    if (!resp && !part) return {};

    // 1. Direct response / output / content / result from resp, then fallback to part
    let val = resp?.response !== undefined ? resp.response :
              (resp?.output !== undefined ? resp.output :
              (resp?.content !== undefined ? resp.content :
              (resp?.result !== undefined ? resp.result : undefined)));

    if (val === undefined && part && part !== resp) {
        val = part.response !== undefined ? part.response :
              (part.output !== undefined ? part.output :
              (part.content !== undefined ? part.content :
              (part.result !== undefined ? part.result : undefined)));
    }

    // Recursively unpack protobuf Struct and Value wrappers (e.g. { fields: { output: { stringValue: '...' } } })
    if (val !== undefined && typeof val === 'object' && val !== null) {
        val = unpackProtobufValue(val);
    }

    // Unpack string from object if present (output, result, content, or text)
    if (val && typeof val === 'object' && !Array.isArray(val)) {
        if (typeof val.output === 'string') {
            val = val.output;
        } else if (typeof val.result === 'string') {
            val = val.result;
        } else if (typeof val.content === 'string') {
            val = val.content;
        } else if (typeof val.text === 'string') {
            val = val.text;
        }
    }

    // 2. If val is effectively empty, check parts (used by Go cortex/genai functionResponseFromString)
    const candParts = [
        resp?.parts,
        part?.parts,
        resp?.response?.parts,
        part?.functionResponse?.parts,
        part?.function_response?.parts
    ].find(p => Array.isArray(p) && p.length > 0) || null;

    if (isEffectivelyEmpty(val) && candParts) {
        const textParts = [];
        for (const p of candParts) {
            if (typeof p === 'string') {
                textParts.push(p);
            } else if (p && typeof p === 'object') {
                if (typeof p.text === 'string') {
                    textParts.push(p.text);
                } else if (p.output !== undefined) {
                    textParts.push(typeof p.output === 'string' ? p.output : JSON.stringify(p.output));
                } else if (p.result !== undefined) {
                    textParts.push(typeof p.result === 'string' ? p.result : JSON.stringify(p.result));
                } else if (p.content !== undefined) {
                    textParts.push(typeof p.content === 'string' ? p.content : JSON.stringify(p.content));
                } else if (p.inlineData?.data || p.inline_data?.data) {
                    const rawData = p.inlineData?.data || p.inline_data?.data;
                    let decoded = null;
                    if (typeof rawData === 'string') {
                        try {
                            const buf = Buffer.from(rawData, 'base64');
                            const utf8 = buf.toString('utf8');
                            if (!utf8.includes('\ufffd') && utf8.length > 0) {
                                decoded = utf8;
                            }
                        } catch {}
                    }
                    textParts.push(decoded || rawData);
                } else if (p.data !== undefined) {
                    if (typeof p.data === 'string') {
                        let decoded = null;
                        try {
                            const buf = Buffer.from(p.data, 'base64');
                            const utf8 = buf.toString('utf8');
                            if (!utf8.includes('\ufffd') && utf8.length > 0) {
                                decoded = utf8;
                            }
                        } catch {}
                        textParts.push(decoded || p.data);
                    } else if (typeof p.data === 'object' && p.data !== null) {
                        if (typeof p.data.data === 'string') {
                            let decoded = null;
                            try {
                                const buf = Buffer.from(p.data.data, 'base64');
                                const utf8 = buf.toString('utf8');
                                if (!utf8.includes('\ufffd') && utf8.length > 0) {
                                    decoded = utf8;
                                }
                            } catch {}
                            textParts.push(decoded || p.data.data);
                        } else {
                            const unpackedData = unpackProtobufValue(p.data);
                            if (typeof unpackedData === 'string') {
                                textParts.push(unpackedData);
                            } else if (typeof unpackedData.text === 'string') {
                                textParts.push(unpackedData.text);
                            } else if (typeof unpackedData.output === 'string') {
                                textParts.push(unpackedData.output);
                            } else if (typeof unpackedData.result === 'string') {
                                textParts.push(unpackedData.result);
                            } else if (typeof unpackedData.content === 'string') {
                                textParts.push(unpackedData.content);
                            } else {
                                textParts.push(JSON.stringify(unpackedData));
                            }
                        }
                    } else {
                        textParts.push(String(p.data));
                    }
                } else if (p.retrievalResult && typeof p.retrievalResult === 'object') {
                    const rText = p.retrievalResult.content || p.retrievalResult.text || '';
                    if (rText) textParts.push(rText);
                }
            }
        }
        if (textParts.length > 0) {
            val = textParts.join('\n');
        }
    }

    // 3. Fall back to error field if execution failed
    const errorKeys = ['error', 'error_details', 'errorDetails', 'errorMessage', 'error_message'];
    const errorSources = [
        resp,
        part,
        resp?.response,
        part?.functionResponse,
        part?.function_response,
        val && typeof val === 'object' && !Array.isArray(val) ? val : null
    ];
    let err = null;
    for (const src of errorSources) {
        if (!src || typeof src !== 'object') continue;
        for (const k of errorKeys) {
            const candidate = src[k];
            const isNonEmpty = candidate && (typeof candidate === 'object' ? Object.keys(candidate).length > 0 : Boolean(candidate));
            if (isNonEmpty) {
                err = candidate;
                break;
            }
        }
        if (err) break;
    }

    if (err) {
        const errStr = typeof err === 'string' ? err : JSON.stringify(err);
        if (typeof val === 'string' && !isEffectivelyEmpty(val)) {
            val = `${val}\nError: ${errStr}`;
        } else {
            val = `Error: ${errStr}`;
        }
    }

    let finalVal = val !== undefined ? val : {};
    if (isEffectivelyEmpty(finalVal)) {
        if (fallbackToolName) {
            finalVal = formatToolSuccessFallback(fallbackToolName);
        } else {
            finalVal = {};
        }
    }

    return finalVal;
}

/**
 * Helper to safely extract function response details from a Gemini part, supporting camelCase, snake_case,
 * alternative toolResponse keys, nested parts, and error details.
 */
function getFunctionResponse(part) {
    if (!part || typeof part !== 'object') return null;
    const resp = part.functionResponse || part.function_response || part.toolResponse || part.tool_response;
    const id = resp?.id || resp?.call_id || resp?.callId || part.id || part.call_id || part.callId || null;
    const name = resp?.name || part?.name || '';
    if (!resp || typeof resp !== 'object') {
        if (part.name && (part.response !== undefined || part.output !== undefined || part.parts !== undefined || part.content !== undefined || part.result !== undefined)) {
            return {
                name,
                response: extractResponseValue(part, part),
                id
            };
        }
        return null;
    }
    return {
        name,
        response: extractResponseValue(resp, part),
        id
    };
}

/**
 * Resolves a tool response to its corresponding tool call ID from conversation history.
 * Consolidates matching across known IDs, tool names, and FIFO pending queues to avoid desync.
 */
function resolveToolCallId(fnResp, pendingCalls, knownCallIds, fallbackPrefix) {
    if (!fnResp) return `${fallbackPrefix}_unknown`;

    let callId = null;
    // 1. Direct match if response ID is already known
    if (fnResp.id && knownCallIds.has(fnResp.id)) {
        callId = fnResp.id;
        const idx = pendingCalls.findIndex(c => c.id === callId);
        if (idx !== -1) pendingCalls.splice(idx, 1);
    } else if (fnResp.name) {
        // 2. Match earliest pending call with the same function name
        const idx = pendingCalls.findIndex(c => c.name === fnResp.name);
        if (idx !== -1) {
            callId = pendingCalls.splice(idx, 1)[0].id;
        }
    }

    // 3. Fallback to earliest pending call across any name
    if (!callId && pendingCalls.length > 0) {
        callId = pendingCalls.shift().id;
    }

    return callId || fnResp.id || `${fallbackPrefix}_unknown`;
}

/**
 * Pre-processes an array of parts to associate empty tool responses with any unconsumed
 * sibling text parts in the same turn, local trajectory/transcript resolver, or apply a sensible fallback message.
 * Returns a Set of consumed parts and a Map of part -> fnResp.
 */
function prepareToolResponses(parts, contentsOrResolver, itemIndex, consumedContentIndices, toolResolver, consumedContentParts) {
    let contents = null;
    let resolver = toolResolver;
    if (typeof contentsOrResolver === 'function' || (contentsOrResolver && typeof contentsOrResolver === 'object' && !Array.isArray(contentsOrResolver))) {
        resolver = contentsOrResolver;
    } else if (Array.isArray(contentsOrResolver)) {
        contents = contentsOrResolver;
    }

    const consumedParts = new Set();
    const fnRespMap = new Map();
    if (!Array.isArray(parts)) {
        return { consumedParts, fnRespMap };
    }

    const fnResps = [];
    for (const part of parts) {
        const fnResp = getFunctionResponse(part);
        if (fnResp) {
            const clonedResp = { ...fnResp };
            fnRespMap.set(part, clonedResp);
            fnResps.push({ part, fnResp: clonedResp });
        }
    }

    for (const { part, fnResp } of fnResps) {
        if (isEffectivelyEmpty(fnResp.response)) {
            // 1. Check sibling text part inside the same turn
            const textSibling = parts.find(p =>
                p !== part &&
                !consumedParts.has(p) &&
                typeof p.text === 'string' &&
                p.text.trim().length > 0 &&
                !p.thought &&
                !getFunctionCall(p) &&
                !fnRespMap.has(p)
            );
            if (textSibling) {
                consumedParts.add(textSibling);
                fnResp.response = textSibling.text;
            }

            // 2. Look ahead in subsequent content items (if available)
            if (isEffectivelyEmpty(fnResp.response) && Array.isArray(contents) && typeof itemIndex === 'number') {
                let nextIdx = itemIndex + 1;
                while (nextIdx < contents.length) {
                    if (consumedContentIndices?.has(nextIdx)) {
                        nextIdx++;
                        continue;
                    }
                    const nextItem = contents[nextIdx];
                    if (nextItem?.role === 'model') break;

                    if (Array.isArray(nextItem?.parts)) {
                        const hasFn = nextItem.parts.some(p => getFunctionResponse(p) || getFunctionCall(p));
                        const textParts = nextItem.parts.filter(p =>
                            typeof p?.text === 'string' &&
                            p.text.trim().length > 0 &&
                            !p.thought
                        );
                        if (textParts.some(p => {
                            const t = (p.text || '').trim();
                            return t.startsWith('<USER_REQUEST>') || t.startsWith('<SYSTEM_MESSAGE>');
                        })) {
                            break;
                        }
                        if (!hasFn && textParts.length > 0) {
                            const text = textParts.map(p => p.text).join('\n');
                            const partWithId = nextItem.parts.find(p => p?.id || p?.call_id || p?.callId || p?.tool_call_id);
                            const candId = nextItem.call_id || nextItem.callId || nextItem.id || nextItem.tool_call_id ||
                                           partWithId?.id || partWithId?.call_id || partWithId?.callId || partWithId?.tool_call_id;
                            if (isToolExecutionOutput(text, candId, [{ id: fnResp.id, name: fnResp.name }])) {
                                fnResp.response = text;
                                const hasMedia = nextItem.parts.some(p => p.inlineData || p.fileData || p.inline_data);
                                if (!hasMedia) {
                                    consumedContentIndices?.add(nextIdx);
                                } else {
                                    for (const tp of textParts) {
                                        consumedContentParts?.add(tp);
                                        consumedParts.add(tp);
                                    }
                                }
                                break;
                            }
                        }
                    }
                    nextIdx++;
                }
            }

            // 3. Hydrate from authentic conversation trajectory / transcript output if resolver is available
            if (isEffectivelyEmpty(fnResp.response) && resolver && typeof resolver === 'function') {
                const hydrated = resolver(fnResp.id, fnResp.name);
                if (hydrated && !isEffectivelyEmpty(hydrated)) {
                    fnResp.response = hydrated;
                }
            }

            // 4. Always set fallback if still effectively empty
            if (isEffectivelyEmpty(fnResp.response)) {
                fnResp.response = formatToolSuccessFallback(fnResp.name);
            }
        }
    }

    return { consumedParts, fnRespMap };
}

/**
 * Converts Gemini contents and systemInstruction into Anthropic Messages format.
 */
function geminiContentsToAnthropic(contents, systemInstruction, options = {}) {
    const toolResolver = options.toolResolver || (options.toolOutputs ? createToolOutputResolver(options.toolOutputs) : null);
    let system = '';
    if (systemInstruction) {
        if (typeof systemInstruction === 'string') {
            system = systemInstruction;
        } else if (Array.isArray(systemInstruction.parts)) {
            system = systemInstruction.parts.map(p => p.text || '').join('\n');
        }
    }

    const rawMessages = [];
    const knownToolCallIds = new Set();
    const pendingCalls = [];
    const consumedContentIndices = new Set();
    const consumedContentParts = new Set();

    function flushPendingAnthropicToolResults() {
        if (pendingCalls.length === 0) return;
        const toolResults = [];
        while (pendingCalls.length > 0) {
            const call = pendingCalls.shift();
            let resp = toolResolver ? toolResolver(call.id, call.name) : null;
            if (isEffectivelyEmpty(resp)) {
                resp = formatToolSuccessFallback(call.name);
            }
            toolResults.push({
                type: 'tool_result',
                tool_use_id: call.id,
                content: typeof resp === 'string' ? resp : JSON.stringify(resp !== undefined ? resp : {})
            });
        }
        if (toolResults.length > 0) {
            rawMessages.push({
                role: 'user',
                content: toolResults
            });
        }
    }

    if (Array.isArray(contents)) {
        for (let cIdx = 0; cIdx < contents.length; cIdx++) {
            if (consumedContentIndices.has(cIdx)) continue;
            const item = contents[cIdx];
            if (!item) continue;

            const role = item.role === 'model' ? 'assistant' : 'user';

            if (item.role === 'model') {
                if (pendingCalls.length > 0 && Array.isArray(item.parts)) {
                    const hasFnCall = item.parts.some(p => getFunctionCall(p));
                    if (!hasFnCall) {
                        const textParts = item.parts.filter(p => typeof p?.text === 'string' && p.text.trim().length > 0 && !p.thought);
                        const allText = textParts.map(p => p.text).join('\n');
                        const partWithId = item.parts.find(p => p?.id || p?.call_id || p?.callId || p?.tool_call_id);
                        const candCallId = item.call_id || item.callId || item.id || item.tool_call_id ||
                                           partWithId?.id || partWithId?.call_id || partWithId?.callId || partWithId?.tool_call_id;
                        if (allText && isToolExecutionOutput(allText, candCallId, pendingCalls)) {
                            const targetCallIndex = candCallId ? pendingCalls.findIndex(c => (c.id || c.callId) === candCallId) : -1;
                            const targetCall = targetCallIndex !== -1 ? pendingCalls.splice(targetCallIndex, 1)[0] : pendingCalls.shift();
                            const targetName = targetCall?.name;
                            const callId = resolveToolCallId({ id: candCallId || targetCall?.id, name: targetName }, [targetCall], knownToolCallIds, 'toolu');
                            let contentStr = allText;
                            if (isEffectivelyEmpty(contentStr)) {
                                contentStr = formatToolSuccessFallback(targetName);
                            }
                            const toolResults = [{
                                type: 'tool_result',
                                tool_use_id: callId,
                                content: contentStr
                            }];
                            while (pendingCalls.length > 0) {
                                const call = pendingCalls.shift();
                                let resp = toolResolver ? toolResolver(call.id, call.name) : null;
                                if (isEffectivelyEmpty(resp)) {
                                    resp = formatToolSuccessFallback(call.name);
                                }
                                toolResults.push({
                                    type: 'tool_result',
                                    tool_use_id: call.id,
                                    content: typeof resp === 'string' ? resp : JSON.stringify(resp !== undefined ? resp : {})
                                });
                            }
                            rawMessages.push({
                                role: 'user',
                                content: toolResults
                            });
                            continue;
                        }
                    }
                }

                flushPendingAnthropicToolResults();

                const blocks = [];
                if (Array.isArray(item.parts)) {
                    for (const part of item.parts) {
                        const fnCall = getFunctionCall(part);
                        if (part.text && !part.thought && !fnCall) {
                            blocks.push({ type: 'text', text: part.text });
                        }
                        if (fnCall) {
                            const callId = fnCall.id || `toolu_${crypto.randomUUID().slice(0, 8)}`;
                            knownToolCallIds.add(callId);
                            pendingCalls.push({ id: callId, name: fnCall.name });

                            let toolInput = fnCall.args || {};
                            if (typeof toolInput === 'string') {
                                try {
                                    toolInput = JSON.parse(toolInput);
                                } catch {
                                    toolInput = {};
                                }
                            }

                            blocks.push({
                                type: 'tool_use',
                                id: callId,
                                name: fnCall.name,
                                input: toolInput
                            });
                        }
                    }
                }
                if (blocks.length > 0) {
                    rawMessages.push({ role, content: blocks });
                }
            } else {
                if (Array.isArray(item.parts)) {
                    const { consumedParts, fnRespMap } = prepareToolResponses(item.parts, contents, cIdx, consumedContentIndices, toolResolver, consumedContentParts);

                    const toolResults = [];
                    const userBlocks = [];
                    let hasFnResp = false;

                    for (const part of item.parts) {
                        if (consumedParts.has(part) || consumedContentParts.has(part)) continue;
                        const fnCall = getFunctionCall(part);
                        const fnResp = fnRespMap.get(part);

                        if (part.text && !part.thought && !fnCall && !fnResp) {
                            userBlocks.push({ type: 'text', text: part.text });
                        }
                        if (fnResp) {
                            hasFnResp = true;
                            const callId = resolveToolCallId(fnResp, pendingCalls, knownToolCallIds, 'toolu');
                            fnResp.id = callId;

                            if (isEffectivelyEmpty(fnResp.response) && toolResolver) {
                                const hydrated = toolResolver(callId, fnResp.name);
                                if (hydrated && !isEffectivelyEmpty(hydrated)) {
                                    fnResp.response = hydrated;
                                }
                            }

                            let respVal = fnResp.response;
                            if (isEffectivelyEmpty(respVal)) {
                                respVal = formatToolSuccessFallback(fnResp.name);
                            }
                            let contentStr = typeof respVal === 'string' ? respVal : JSON.stringify(respVal !== undefined ? respVal : {});
                            toolResults.push({
                                type: 'tool_result',
                                tool_use_id: callId,
                                content: contentStr
                            });
                        }
                        if (part.inlineData) {
                            userBlocks.push({
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: part.inlineData.mimeType || 'image/jpeg',
                                    data: part.inlineData.data
                                }
                            });
                        }
                    }

                    // If this turn had NO functionResponse parts, BUT there are pending tool calls:
                    if (!hasFnResp && pendingCalls.length > 0 && userBlocks.length > 0) {
                        const textBlocks = userBlocks.filter(b => b.type === 'text');
                        const allText = textBlocks.map(b => b.text).join('\n');
                        const partWithId = item.parts?.find(p => p?.id || p?.call_id || p?.callId || p?.tool_call_id);
                        const candCallId = item.call_id || item.callId || item.id || item.tool_call_id ||
                                           partWithId?.id || partWithId?.call_id || partWithId?.callId || partWithId?.tool_call_id;
                        if (isToolExecutionOutput(allText, candCallId, pendingCalls)) {
                            const targetCall = (candCallId && pendingCalls.find(c => (c.id || c.callId) === candCallId)) || pendingCalls[0];
                            const targetName = targetCall?.name;
                            const callId = resolveToolCallId({ id: candCallId, name: targetName }, pendingCalls, knownToolCallIds, 'toolu');
                            let contentStr = allText;
                            if (isEffectivelyEmpty(contentStr)) {
                                contentStr = formatToolSuccessFallback(targetName);
                            }
                            toolResults.push({
                                type: 'tool_result',
                                tool_use_id: callId,
                                content: contentStr
                            });
                            const nonTextBlocks = userBlocks.filter(b => b.type !== 'text');
                            userBlocks.length = 0;
                            userBlocks.push(...nonTextBlocks);
                        }
                    }

                    if (pendingCalls.length > 0) {
                        while (pendingCalls.length > 0) {
                            const call = pendingCalls.shift();
                            let resp = toolResolver ? toolResolver(call.id, call.name) : null;
                            if (isEffectivelyEmpty(resp)) {
                                resp = formatToolSuccessFallback(call.name);
                            }
                            toolResults.push({
                                type: 'tool_result',
                                tool_use_id: call.id,
                                content: typeof resp === 'string' ? resp : JSON.stringify(resp !== undefined ? resp : {})
                            });
                        }
                    }

                    const combined = [...toolResults, ...userBlocks];
                    if (combined.length > 0) {
                        rawMessages.push({ role: 'user', content: combined });
                    }
                }
            }
        }
    }

    const messages = coalesceAnthropicMessages(rawMessages);
    return { system: system.trim() || undefined, messages };
}

/**
 * Converts Gemini contents and systemInstruction into OpenAI chat completion messages array.
 */
function geminiContentsToOpenAI(contents, systemInstruction, options = {}) {
    const toolResolver = options.toolResolver || (options.toolOutputs ? createToolOutputResolver(options.toolOutputs) : null);
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

    const knownToolCallIds = new Set();
    const pendingCalls = [];
    const consumedContentIndices = new Set();
    const consumedContentParts = new Set();

    function flushPendingOpenAIToolResults() {
        if (pendingCalls.length === 0) return;
        while (pendingCalls.length > 0) {
            const call = pendingCalls.shift();
            let resp = toolResolver ? toolResolver(call.id, call.name) : null;
            if (isEffectivelyEmpty(resp)) {
                resp = formatToolSuccessFallback(call.name);
            }
            messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: typeof resp === 'string' ? resp : JSON.stringify(resp !== undefined ? resp : {})
            });
        }
    }

    if (Array.isArray(contents)) {
        for (let cIdx = 0; cIdx < contents.length; cIdx++) {
            if (consumedContentIndices.has(cIdx)) continue;
            const item = contents[cIdx];
            if (!item) continue;

            if (item.role === 'model') {
                if (pendingCalls.length > 0 && Array.isArray(item.parts)) {
                    const hasFnCall = item.parts.some(p => getFunctionCall(p));
                    if (!hasFnCall) {
                        const textParts = item.parts.filter(p => typeof p?.text === 'string' && p.text.trim().length > 0 && !p.thought);
                        const allText = textParts.map(p => p.text).join('\n');
                        const partWithId = item.parts.find(p => p?.id || p?.call_id || p?.callId || p?.tool_call_id);
                        const candCallId = item.call_id || item.callId || item.id || item.tool_call_id ||
                                           partWithId?.id || partWithId?.call_id || partWithId?.callId || partWithId?.tool_call_id;
                        if (allText && isToolExecutionOutput(allText, candCallId, pendingCalls)) {
                            const targetCallIndex = candCallId ? pendingCalls.findIndex(c => (c.id || c.callId) === candCallId) : -1;
                            const targetCall = targetCallIndex !== -1 ? pendingCalls.splice(targetCallIndex, 1)[0] : pendingCalls.shift();
                            const targetName = targetCall?.name;
                            const callId = resolveToolCallId({ id: candCallId || targetCall?.id, name: targetName }, [targetCall], knownToolCallIds, 'call');
                            let contentStr = allText;
                            if (isEffectivelyEmpty(contentStr)) {
                                contentStr = formatToolSuccessFallback(targetName);
                            }
                            messages.push({
                                role: 'tool',
                                tool_call_id: callId,
                                content: contentStr
                            });
                            while (pendingCalls.length > 0) {
                                const call = pendingCalls.shift();
                                let resp = toolResolver ? toolResolver(call.id, call.name) : null;
                                if (isEffectivelyEmpty(resp)) {
                                    resp = formatToolSuccessFallback(call.name);
                                }
                                messages.push({
                                    role: 'tool',
                                    tool_call_id: call.id,
                                    content: typeof resp === 'string' ? resp : JSON.stringify(resp !== undefined ? resp : {})
                                });
                            }
                            continue;
                        }
                    }
                }

                flushPendingOpenAIToolResults();

                const textParts = [];
                const toolCalls = [];

                if (Array.isArray(item.parts)) {
                    for (const part of item.parts) {
                        const fnCall = getFunctionCall(part);
                        if (part.text && !part.thought && !fnCall) {
                            textParts.push(part.text);
                        }
                        if (fnCall) {
                            const callId = fnCall.id || `call_${crypto.randomUUID().slice(0, 8)}`;
                            knownToolCallIds.add(callId);
                            pendingCalls.push({ id: callId, name: fnCall.name });
                            toolCalls.push({
                                id: callId,
                                type: 'function',
                                function: {
                                    name: fnCall.name,
                                    arguments: typeof fnCall.args === 'string'
                                        ? fnCall.args
                                        : JSON.stringify(fnCall.args || {})
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
                    const toolMessages = [];
                    const userTextParts = [];
                    const userImageParts = [];

                    const { consumedParts, fnRespMap } = prepareToolResponses(item.parts, contents, cIdx, consumedContentIndices, toolResolver, consumedContentParts);

                    let hasFnResp = false;
                    for (const part of item.parts) {
                        if (consumedParts.has(part) || consumedContentParts.has(part)) continue;
                        const fnResp = fnRespMap.get(part);
                        if (fnResp) {
                            hasFnResp = true;
                            const callId = resolveToolCallId(fnResp, pendingCalls, knownToolCallIds, 'call');
                            fnResp.id = callId;

                            if (isEffectivelyEmpty(fnResp.response) && toolResolver) {
                                const hydrated = toolResolver(callId, fnResp.name);
                                if (hydrated && !isEffectivelyEmpty(hydrated)) {
                                    fnResp.response = hydrated;
                                }
                            }

                            let respVal = fnResp.response;
                            if (isEffectivelyEmpty(respVal)) {
                                respVal = formatToolSuccessFallback(fnResp.name);
                            }
                            toolMessages.push({
                                role: 'tool',
                                tool_call_id: callId,
                                content: typeof respVal === 'string'
                                    ? respVal
                                    : JSON.stringify(respVal !== undefined ? respVal : {})
                            });
                        } else if (part.text) {
                            userTextParts.push(part.text);
                        } else if (part.inlineData || part.inline_data) {
                            const rawData = part.inlineData || part.inline_data;
                            userImageParts.push({
                                type: 'image_url',
                                image_url: {
                                    url: `data:${rawData.mimeType || rawData.mime_type || 'image/jpeg'};base64,${rawData.data}`
                                }
                            });
                        }
                    }

                    // If this turn had NO functionResponse parts, BUT there are pending tool calls:
                    if (!hasFnResp && pendingCalls.length > 0 && (userTextParts.length > 0 || userImageParts.length > 0)) {
                        const allText = userTextParts.join('\n');
                        const partWithId = item.parts?.find(p => p?.id || p?.call_id || p?.callId || p?.tool_call_id);
                        const candCallId = item.call_id || item.callId || item.id || item.tool_call_id ||
                                           partWithId?.id || partWithId?.call_id || partWithId?.callId || partWithId?.tool_call_id;
                        if (isToolExecutionOutput(allText, candCallId, pendingCalls)) {
                            const targetCall = (candCallId && pendingCalls.find(c => (c.id || c.callId) === candCallId)) || pendingCalls[0];
                            const targetName = targetCall?.name;
                            const callId = resolveToolCallId({ id: candCallId, name: targetName }, pendingCalls, knownToolCallIds, 'call');
                            let respContent = allText;
                            if (isEffectivelyEmpty(respContent)) {
                                respContent = formatToolSuccessFallback(targetName);
                            }
                            toolMessages.push({
                                role: 'tool',
                                tool_call_id: callId,
                                content: respContent
                            });
                            userTextParts.length = 0;
                        }
                    }

                    if (pendingCalls.length > 0) {
                        while (pendingCalls.length > 0) {
                            const call = pendingCalls.shift();
                            let resp = toolResolver ? toolResolver(call.id, call.name) : null;
                            if (isEffectivelyEmpty(resp)) {
                                resp = formatToolSuccessFallback(call.name);
                            }
                            toolMessages.push({
                                role: 'tool',
                                tool_call_id: call.id,
                                content: typeof resp === 'string' ? resp : JSON.stringify(resp !== undefined ? resp : {})
                            });
                        }
                    }

                    // Tool responses must immediately follow the assistant tool_calls in ChatML
                    for (const tm of toolMessages) {
                        messages.push(tm);
                    }

                    // Accompanying user text / media emitted after tool responses
                    if (userTextParts.length > 0 || userImageParts.length > 0) {
                        if (userImageParts.length > 0) {
                            const content = [];
                            if (userTextParts.length > 0) {
                                content.push({ type: 'text', text: userTextParts.join('\n') });
                            }
                            content.push(...userImageParts);
                            messages.push({ role: 'user', content });
                        } else {
                            messages.push({ role: 'user', content: userTextParts.join('\n') });
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
    geminiContentsToOpenAI,
    getFunctionCall,
    isEffectivelyEmpty,
    extractResponseValue,
    getFunctionResponse,
    resolveToolCallId,
    sanitizeToolCallArgs,
    unpackProtobufValue,
    formatToolSuccessFallback,
    prepareToolResponses,
    isToolExecutionOutput,
    resolveConversationToolOutputs,
    createToolOutputResolver,
    DEFAULT_REQUEST_TIMEOUT_MS,
    getRequestTimeout,
    formatTimeoutError,
    EMPTY_COMPLETION_FALLBACK_TEXT,
    createSettledPromise
};
