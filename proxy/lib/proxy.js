'use strict';

const { replaceFaviconInHtml } = require('./favicon');
const { renderServiceStartingPage } = require('./pages');
const { INJECTED_UI_STYLES, buildInjectedScript } = require('./ui-injection');
const {
    CUSTOM_PLACEHOLDER_REGEX,
    isCustomPlaceholder,
    matchCustomPlaceholders
} = require('./models-manager');

// Hop-by-hop headers defined in RFC 7230 / RFC 9110 to strip when proxying
const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'transfer-encoding',
    'upgrade',
]);

// Helper to determine if a request path corresponds to a browser SPA frontend route
function isSpaRoute(pathname) {
    if (pathname === '/' || pathname === '/index.html') return true;
    if (pathname.startsWith('/c/') || pathname === '/c') return true;
    if (pathname.startsWith('/history')) return true;
    if (pathname.startsWith('/projects')) return true;
    if (pathname.startsWith('/tasks')) return true;
    return false;
}

// Convert headers to a standard lowercased key-value map filtering hop-by-hop headers
function getHeaderMap(headers) {
    const out = {};
    if (headers && typeof headers.entries === 'function') {
        for (const [k, v] of headers.entries()) {
            if (!HOP_BY_HOP_HEADERS.has(k.toLowerCase())) {
                out[k.toLowerCase()] = v;
            }
        }
    } else if (headers && typeof headers === 'object') {
        for (const [k, v] of Object.entries(headers)) {
            if (!HOP_BY_HOP_HEADERS.has(k.toLowerCase())) {
                out[k.toLowerCase()] = v;
            }
        }
    }
    return out;
}

const MAX_ACTIVE_CONVERSATIONS = 500;
const activeConversationModels = new Map();

function setTrackedModel(key, modelConfig, map = activeConversationModels) {
    if (!key) return;
    if (map.size >= MAX_ACTIVE_CONVERSATIONS && !map.has(key)) {
        for (const k of map.keys()) {
            if (k !== 'latest' && k !== 'latestConvoId') {
                map.delete(k);
                break;
            }
        }
    }
    map.set(key, modelConfig);
}

// Modern Web standard reverse proxy handler for Hono & Bun
async function proxyWebRequest(c, targetPort, targetPath, options = {}) {
    const { isTerminal, isIde, isUpstream, sidecarManager, modelsManager } = options;

    // Guard against scheme-relative URLs and SSRF: ensure targetPath starts with single slash
    const safePath = '/' + targetPath.replace(/^\/+/, '');
    const targetUrl = new URL(safePath, `http://127.0.0.1:${targetPort}`);
    if (targetUrl.hostname !== '127.0.0.1' || targetUrl.port !== String(targetPort)) {
        return c.text('Invalid proxy target', 400);
    }

    const proxyHeaders = getHeaderMap(c.req.raw.headers);
    proxyHeaders['host'] = `localhost:${targetPort}`;
    proxyHeaders['origin'] = `http://localhost:${targetPort}`;

    const referer = c.req.header('referer');
    if (referer) {
        proxyHeaders['referer'] = referer.replace(/^https?:\/\/[^/]+/, `http://localhost:${targetPort}`);
    }

    const parsedUrl = new URL(c.req.raw.url);
    const convoMatch = parsedUrl.pathname.match(/\/c\/([0-9a-fA-F-]{36})/);
    if (convoMatch) {
        activeConversationModels.set('latestConvoId', convoMatch[1]);
    } else if (referer) {
        const refMatch = referer.match(/\/c\/([0-9a-fA-F-]{36})/);
        if (refMatch) {
            activeConversationModels.set('latestConvoId', refMatch[1]);
        }
    }

    const isModelEndpoint = isModelProcedure(parsedUrl.pathname);
    const shouldInterceptModels = Boolean(
        isUpstream &&
        modelsManager &&
        typeof modelsManager.hasEnabledModels === 'function' &&
        modelsManager.hasEnabledModels() &&
        isModelEndpoint
    );

    const wantsHtml = (c.req.header('accept') || '').includes('text/html') ||
        targetPath === '/' || targetPath === '/terminal' || targetPath === '/terminal/' || targetPath.startsWith('/?') ||
        shouldInterceptModels;
    if (wantsHtml) {
        proxyHeaders['accept-encoding'] = 'identity';
    }

    const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';
    let requestBody = undefined;

    if (hasBody) {
        if (isUpstream && parsedUrl.pathname.startsWith('/exa.language_server_pb.LanguageServerService/')) {
            try {
                let textBody = await c.req.text();
                let parsed = null;
                try { parsed = JSON.parse(textBody); } catch (e) {}
                const cascadeId = parsed?.cascadeId || parsed?.payload?.cascadeId;
                const convoId = parsed?.conversationId || parsed?.payload?.conversationId;
                if (convoId || cascadeId) {
                    activeConversationModels.set('latestConvoId', convoId || cascadeId);
                }

                const matches = matchCustomPlaceholders(textBody);
                if (matches.length > 0) {
                    for (const placeholder of matches) {
                        const modelConfig = modelsManager?.getModelByPlaceholder?.(placeholder);
                        if (modelConfig) {
                            if (cascadeId) setTrackedModel(cascadeId, modelConfig);
                            if (convoId) setTrackedModel(convoId, modelConfig);
                            if (convoId || cascadeId) activeConversationModels.set('latestConvoId', convoId || cascadeId);
                            setTrackedModel('latest', modelConfig);
                        }
                    }
                }
                requestBody = textBody;
            } catch (readErr) {
                requestBody = c.req.raw.body;
            }
        } else {
            requestBody = c.req.raw.body;
        }
    }

    try {
        const upstreamRes = await fetch(targetUrl.toString(), {
            method: c.req.method,
            headers: proxyHeaders,
            body: requestBody,
            redirect: 'manual',
            // @ts-ignore
            duplex: 'half'
        });

        const resHeaders = new Headers();
        for (const [key, value] of upstreamRes.headers.entries()) {
            if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== 'content-encoding') {
                resHeaders.set(key, value);
            }
        }
        resHeaders.set('x-accel-buffering', 'no');

        const allowedOrigins = process.env.ALLOWED_ORIGINS
            ? new Set(process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()))
            : null;
        const originHeader = c.req.header('origin');
        if (upstreamRes.headers.has('access-control-allow-origin') && originHeader) {
            if (allowedOrigins && allowedOrigins.has(originHeader)) {
                resHeaders.set('access-control-allow-origin', originHeader);
            } else if (!allowedOrigins) {
                resHeaders.delete('access-control-allow-origin');
            }
        }

        if (isIde && resHeaders.has('location')) {
            const loc = resHeaders.get('location');
            if (loc && loc.startsWith('/')) {
                resHeaders.set('location', '/ide' + loc);
            }
        }

        const contentType = upstreamRes.headers.get('content-type') || '';
        const isHtmlResponse = contentType.includes('text/html');

        if (isHtmlResponse && c.req.method === 'GET') {
            let html = await upstreamRes.text();

            if (isTerminal) {
                html = replaceFaviconInHtml(html);
                html = html.replace(/<title>ttyd - Terminal<\/title>/i, '<title>Antigravity Terminal</title>');
            } else if (isIde) {
                html = replaceFaviconInHtml(html);
            } else if (isUpstream) {
                const csrfMatch = html.match(/"csrfToken":"([^"]+)"/);
                if (csrfMatch && sidecarManager) {
                    sidecarManager.setCsrfToken(csrfMatch[1]);
                }

                html = replaceFaviconInHtml(html);

                const customScript = buildInjectedScript();
                if (customScript) {
                    const injection = `<style>${INJECTED_UI_STYLES}</style><script id="agy-injected-tools-script">${customScript}</script>`;
                    if (html.includes('</body>')) {
                        html = html.replace('</body>', `${injection}</body>`);
                    } else if (html.includes('</html>')) {
                        html = html.replace('</html>', `${injection}</html>`);
                    } else {
                        html += injection;
                    }
                }
            }

            resHeaders.delete('content-length');
            return new Response(html, {
                status: upstreamRes.status,
                headers: resHeaders
            });
        }

        if (shouldInterceptModels && upstreamRes.ok) {
            let rawText;
            try {
                rawText = await upstreamRes.text();
            } catch (readErr) {
                throw readErr;
            }

            try {
                const data = JSON.parse(rawText);
                if (data && typeof data === 'object') {
                    injectCustomModels(data, modelsManager);
                    resHeaders.delete('content-length');
                    return c.json(data, upstreamRes.status, Object.fromEntries(resHeaders.entries()));
                }
            } catch (parseErr) {
                // Fallback to returning original raw text without touching upstreamRes.body
            }

            return new Response(rawText, {
                status: upstreamRes.status,
                headers: resHeaders
            });
        }

        return new Response(upstreamRes.body, {
            status: upstreamRes.status,
            headers: resHeaders
        });
    } catch (err) {
        console.error(`[HTTP Gateway Upstream Error] ${c.req.method} ${targetPath} -> port ${targetPort}:`, err.message);
        if (isTerminal) {
            return c.html(renderServiceStartingPage('Host Terminal'), 503);
        } else if (isIde) {
            return c.html(renderServiceStartingPage('Web IDE'), 503);
        } else {
            return c.text('Antigravity upstream server unavailable.', 502);
        }
    }
}

const MODEL_PROCEDURE_ENDPOINTS = [
    '/GetUserStatus',
    '/GetCascadeModelConfigData',
    '/GetCascadeModelConfigs'
];

/**
 * Checks if an RPC procedure name or request path corresponds to a model configuration endpoint.
 */
function isModelProcedure(pathOrName) {
    if (typeof pathOrName !== 'string') return false;
    return MODEL_PROCEDURE_ENDPOINTS.some(endpoint => pathOrName.endsWith(endpoint));
}

const MAX_CONCURRENT_STREAMS = 500;

/**
 * Inspects outgoing client messages on /connect-websocket, tracks active stream IDs,
 * and maps custom model placeholders to active conversation/cascade context for translation.
 */
function handleWebSocketClientMessage(ws, message, modelsManager, activeModelsMap = activeConversationModels) {
    if (!ws.data || !ws.data.activeStreams) return message;

    let isJsonCandidate = false;
    let text = null;
    let isBinary = false;

    if (typeof message === 'string') {
        if (message.startsWith('{')) {
            isJsonCandidate = true;
            text = message;
        }
    } else if (message && typeof message === 'object') {
        const u8 = new Uint8Array(message);
        if (u8.length > 0 && u8[0] === 0x7b /* '{' */) {
            isJsonCandidate = true;
            text = Buffer.from(message).toString('utf8');
            isBinary = true;
        }
    }

    if (!isJsonCandidate || !text) return message;

    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
            if (parsed.type === 'start' && parsed.streamId && typeof parsed.procedure === 'string') {
                if (ws.data.activeStreams.size >= MAX_CONCURRENT_STREAMS) {
                    const oldest = ws.data.activeStreams.keys().next().value;
                    if (oldest !== undefined) ws.data.activeStreams.delete(oldest);
                }
                ws.data.activeStreams.set(parsed.streamId, parsed.procedure);
            } else if (parsed.type === 'cancel' && parsed.streamId) {
                ws.data.activeStreams.delete(parsed.streamId);
            }

            const cascadeId = parsed.payload?.cascadeId || parsed.cascadeId;
            const convoId = parsed.payload?.conversationId || parsed.conversationId;
            if (convoId || cascadeId) {
                activeModelsMap.set('latestConvoId', convoId || cascadeId);
            }

            const matches = matchCustomPlaceholders(text);
            if (matches.length > 0) {
                if (modelsManager) {
                    for (const placeholder of matches) {
                        const modelConfig = modelsManager.getModelByPlaceholder(placeholder);
                        if (modelConfig) {
                            if (cascadeId) setTrackedModel(cascadeId, modelConfig, activeModelsMap);
                            if (convoId) setTrackedModel(convoId, modelConfig, activeModelsMap);
                            if (convoId || cascadeId) activeModelsMap.set('latestConvoId', convoId || cascadeId);
                            setTrackedModel('latest', modelConfig, activeModelsMap);
                        }
                    }
                }

                // Native placeholder preservation: agy accepts M500..M649 via fetchAvailableModels interception
                return message;
            } else {
                // Only remove from active models if the message explicitly specifies a standard model
                const explicitModel = parsed.payload?.cascadeConfig?.plannerConfig?.planModel ||
                                      parsed.payload?.model ||
                                      parsed.model;

                if (explicitModel && typeof explicitModel === 'string' && !CUSTOM_PLACEHOLDER_REGEX.test(explicitModel)) {
                    const cascadeId = parsed.payload?.cascadeId || parsed.cascadeId;
                    const convoId = parsed.payload?.conversationId || parsed.conversationId;
                    if (cascadeId && activeModelsMap.has(cascadeId)) {
                        activeModelsMap.delete(cascadeId);
                    }
                    if (convoId && activeModelsMap.has(convoId)) {
                        activeModelsMap.delete(convoId);
                    }
                }
            }
        }
    } catch (e) {}

    return message;
}

/**
 * Inspects incoming upstream messages on /connect-websocket and injects custom models on model RPCs.
 */
function handleWebSocketUpstreamMessage(ws, event, modelsManager) {
    let dataToSend = event.data;
    if (!ws.data || !ws.data.activeStreams || ws.data.activeStreams.size === 0) {
        return dataToSend;
    }

    let isJsonCandidate = false;
    let text = null;

    if (typeof event.data === 'string') {
        if (event.data.startsWith('{')) {
            isJsonCandidate = true;
            text = event.data;
        }
    } else if (event.data && typeof event.data === 'object') {
        const u8 = new Uint8Array(event.data);
        if (u8.length > 0 && u8[0] === 0x7b /* '{' */) {
            isJsonCandidate = true;
            text = Buffer.from(event.data).toString('utf8');
        }
    }

    if (!isJsonCandidate || !text) return dataToSend;

    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
            if (parsed.type === 'data' && parsed.streamId && ws.data.activeStreams.has(parsed.streamId)) {
                const procedure = ws.data.activeStreams.get(parsed.streamId);
                if (isModelProcedure(procedure) && modelsManager && typeof modelsManager.hasEnabledModels === 'function' && modelsManager.hasEnabledModels()) {
                    if (parsed.payload) {
                        injectCustomModels(parsed.payload, modelsManager);
                        dataToSend = JSON.stringify(parsed);
                    }
                }
            } else if (parsed.type === 'end' && parsed.streamId) {
                ws.data.activeStreams.delete(parsed.streamId);
            }
        }
    } catch (e) {}

    return dataToSend;
}

/**
 * Injects custom models from ModelsManager into a Connect-RPC response data payload in-place.
 * Supports GetUserStatus, GetCascadeModelConfigData, and GetCascadeModelConfigs schemas.
 * Returns the mutated data payload.
 */
function injectCustomModels(data, modelsManager) {
    if (!data || typeof data !== 'object' || !modelsManager) return data;
    if (typeof modelsManager.getInjectedModels !== 'function') return data;

    let targetConfigData = data;
    if (data.userStatus) {
        data.userStatus.cascadeModelConfigData = data.userStatus.cascadeModelConfigData || {};
        targetConfigData = data.userStatus.cascadeModelConfigData;
    } else if (data.cascadeModelConfigData) {
        targetConfigData = data.cascadeModelConfigData;
    }

    targetConfigData.clientModelConfigs = targetConfigData.clientModelConfigs || [];

    const existingEnums = new Set();
    for (const existing of targetConfigData.clientModelConfigs) {
        if (existing.modelOrAlias?.model) {
            existingEnums.add(existing.modelOrAlias.model);
        }
    }

    const injected = modelsManager.getInjectedModels(existingEnums);
    if (!injected || injected.length === 0) return data;

    for (const m of injected) {
        const alreadyExists = targetConfigData.clientModelConfigs.some(existing =>
            (existing.modelId && existing.modelId === m.modelId) ||
            (existing.modelOrAlias?.model && existing.modelOrAlias.model === m.modelOrAlias?.model)
        );
        if (!alreadyExists) {
            targetConfigData.clientModelConfigs.push(m);
        }
    }

    if (Array.isArray(targetConfigData.clientModelSorts) && targetConfigData.clientModelSorts.length > 0) {
        const recommendedSort = targetConfigData.clientModelSorts.find(s =>
            s.name && s.name.toLowerCase() === 'recommended'
        ) || targetConfigData.clientModelSorts[0];

        const group = recommendedSort.groups?.[0];
        if (group && Array.isArray(group.modelLabels)) {
            for (const m of injected) {
                if (!group.modelLabels.includes(m.label)) {
                    group.modelLabels.push(m.label);
                }
            }
        }
    }

    return data;
}

module.exports = {
    isSpaRoute,
    isModelProcedure,
    handleWebSocketClientMessage,
    handleWebSocketUpstreamMessage,
    proxyWebRequest,
    replaceFaviconInHtml,
    injectCustomModels,
    activeConversationModels
};
