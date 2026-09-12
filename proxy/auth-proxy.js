#!/usr/bin/env bun
'use strict';

import { Hono } from 'hono';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);

const {
    LISTEN_PORT,
    AGY_HUB_PORT,
    AUTH_PASSWORD,
    PORT_FILE,
    ENABLE_TERMINAL,
    ENABLE_IDE,
    TERMINAL_PORT,
    IDE_PORT,
    TRUST_PROXY
} = require('./lib/config.js');

const {
    isAuthenticated,
    activeSessions,
    loginRateLimiter,
    parseCookiesFromHeader,
    checkRateLimit,
    recordFailedAttempt,
    SESSION_TTL_MS
} = require('./lib/session.js');

const { safeCompare } = require('./lib/security.js');
const { isFaviconRequest, getFaviconAsset } = require('./lib/favicon.js');
const {
    renderLoginPage,
    renderStatusPage,
    renderStartingPage,
    renderSidecarsPage,
    renderModelsPage,
    checkUpstreamHealth
} = require('./lib/pages.js');
const {
    isSpaRoute,
    proxyWebRequest,
    handleWebSocketClientMessage,
    handleWebSocketUpstreamMessage,
    activeConversationModels
} = require('./lib/proxy.js');
const { defaultManager: modelsManager, maskApiKey } = require('./lib/models-manager.js');

let TranslationProxy;
try {
    const tp = require('./translation-proxy.js');
    TranslationProxy = tp.TranslationProxy;
} catch (e) {
    try {
        const tp = require('/usr/local/bin/translation-proxy.js');
        TranslationProxy = tp.TranslationProxy;
    } catch (err) {
        console.error('[Proxy Gateway] Warning: translation-proxy module could not be loaded:', err.message);
    }
}

let sidecarManager;
try {
    sidecarManager = require('./sidecar-manager.js');
} catch (e) {
    try {
        sidecarManager = require('/usr/local/bin/sidecar-manager.js');
    } catch (err) {
        console.error('[Proxy Gateway] Warning: sidecar-manager module could not be loaded:', err.message);
    }
}

const TRANSLATION_PORT = process.env.TRANSLATION_PORT
    ? parseInt(process.env.TRANSLATION_PORT, 10)
    : (LISTEN_PORT === 4400 ? 4405 : (LISTEN_PORT > 0 ? LISTEN_PORT + 5 : 4405));

let TARGET_PORT = AGY_HUB_PORT;
if (sidecarManager && TARGET_PORT) {
    sidecarManager.setLsAddress(`127.0.0.1:${TARGET_PORT}`);
}

function setTargetPort(port) {
    const newPort = parseInt(port, 10);
    if (!newPort || newPort === TARGET_PORT) return;
    TARGET_PORT = newPort;
    console.log(`[Proxy Gateway] 🔗 Bridged port ${LISTEN_PORT} -> http://127.0.0.1:${TARGET_PORT}`);
    if (sidecarManager) {
        sidecarManager.setLsAddress(`127.0.0.1:${TARGET_PORT}`);
        sidecarManager.getCsrfToken().catch(() => {});
    }
}

function checkPortFile() {
    try {
        if (fs.existsSync(PORT_FILE)) {
            const content = fs.readFileSync(PORT_FILE, 'utf8').trim();
            const port = parseInt(content, 10);
            if (port && port !== TARGET_PORT) {
                setTargetPort(port);
            }
        }
    } catch (e) {}
}

function getClientIpFromContext(c, srv) {
    if (TRUST_PROXY && c.req.header('x-forwarded-for')) {
        return c.req.header('x-forwarded-for').split(',')[0].trim();
    }
    if (srv) {
        try {
            const ip = srv.requestIP(c.req.raw);
            if (ip && ip.address) {
                return ip.address.replace(/^::ffff:/, '');
            }
        } catch (e) {}
    }
    return '127.0.0.1';
}

const app = new Hono();

// Global middleware: Apply standard HTTP Security Headers (SEC-14)
app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'SAMEORIGIN');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' ws: wss:; frame-ancestors 'self';");
    c.header('X-Accel-Buffering', 'no');
    const isHttps = c.req.header('x-forwarded-proto') === 'https';
    if (isHttps) {
        c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
});

// Favicon & app icon requests (ALWAYS UNAUTHENTICATED)
app.use('*', async (c, next) => {
    if (isFaviconRequest(c.req.path)) {
        const { contentType, data } = getFaviconAsset(c.req.path);
        return new Response(data, {
            status: 200,
            headers: {
                'Content-Type': contentType,
                'Content-Length': String(data.length),
                'Cache-Control': 'public, max-age=86400, must-revalidate',
                'X-Content-Type-Options': 'nosniff'
            }
        });
    }
    return next();
});

// /status health check endpoint (ALWAYS UNAUTHENTICATED)
async function handleStatus(c) {
    checkPortFile();
    const health = await checkUpstreamHealth(TARGET_PORT);
    const statusCode = health.up ? 200 : 503;
    const wantsJson = c.req.header('accept')?.includes('application/json') || c.req.query('format') === 'json';

    if (wantsJson) {
        return c.json({ status: health.up ? 'ok' : 'error' }, statusCode, {
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
    }
    return c.html(renderStatusPage(health), statusCode, {
        'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
}
app.get('/status', handleStatus);
app.get('/status/', handleStatus);

// Logout (GET & POST)
app.all('/__auth/logout', (c) => {
    const cookieHeader = c.req.header('cookie');
    const cookies = parseCookiesFromHeader(cookieHeader);
    if (cookies['antigravity_session']) {
        activeSessions.delete(cookies['antigravity_session']);
    }
    c.header('Set-Cookie', 'antigravity_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    return c.redirect('/__auth/login', 302);
});

// Login GET
app.get('/__auth/login', (c) => {
    return c.html(renderLoginPage(), 200);
});

// Login POST
app.post('/__auth/login', async (c) => {
    const srv = c.env?.server;
    const clientIp = getClientIpFromContext(c, srv);
    const rateCheck = checkRateLimit(clientIp);

    if (!rateCheck.allowed) {
        return c.html(renderLoginPage(rateCheck.message), 429);
    }

    const contentLength = parseInt(c.req.header('content-length') || '0', 10);
    if (contentLength > 16 * 1024) {
        return c.text('Payload Too Large', 413);
    }

    let bodyText = '';
    try {
        const reader = c.req.raw.body?.getReader();
        if (reader) {
            const chunks = [];
            let total = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.length;
                if (total > 16 * 1024) {
                    return c.text('Payload Too Large', 413);
                }
                chunks.push(value);
            }
            bodyText = Buffer.concat(chunks).toString('utf8');
        } else {
            bodyText = await c.req.text();
        }
    } catch (e) {
        return c.text('Bad Request', 400);
    }

    const params = new URLSearchParams(bodyText);
    const enteredPassword = params.get('password') || '';

    if (AUTH_PASSWORD && safeCompare(enteredPassword, AUTH_PASSWORD)) {
        loginRateLimiter.delete(clientIp);

        const sessionToken = crypto.randomBytes(32).toString('hex');
        const now = Date.now();
        activeSessions.set(sessionToken, {
            createdAt: now,
            expiresAt: now + SESSION_TTL_MS
        });

        const isHttps = c.req.header('x-forwarded-proto') === 'https';
        const secureFlag = isHttps ? '; Secure' : '';

        c.header('Set-Cookie', `antigravity_session=${sessionToken}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secureFlag}`);
        return c.redirect('/?useWebSocket=true', 302);
    } else {
        recordFailedAttempt(clientIp);
        return c.html(renderLoginPage('Incorrect password. Please try again.'), 401);
    }
});

// Authentication guard for ALL other routes
app.use('*', async (c, next) => {
    if (!isAuthenticated(c)) {
        if (c.req.path.startsWith('/api/')) {
            return c.json({ error: 'Unauthorized. Please sign in.' }, 401);
        }
        return c.html(renderLoginPage(), 200);
    }
    return next();
});

// UI routes
app.get('/sidecars', (c) => c.html(renderSidecarsPage(), 200, { 'Cache-Control': 'no-cache, no-store, must-revalidate' }));
app.get('/sidecars/', (c) => c.html(renderSidecarsPage(), 200, { 'Cache-Control': 'no-cache, no-store, must-revalidate' }));
app.get('/models', (c) => c.html(renderModelsPage(), 200, { 'Cache-Control': 'no-cache, no-store, must-revalidate' }));
app.get('/models/', (c) => c.html(renderModelsPage(), 200, { 'Cache-Control': 'no-cache, no-store, must-revalidate' }));

// REST: Projects
app.get('/api/projects', (c) => {
    const projects = sidecarManager ? sidecarManager.listProjects() : [];
    return c.json(projects);
});

// REST: Sidecars
app.get('/api/sidecars', (c) => {
    if (!sidecarManager) return c.json({ error: 'Sidecar manager subsystem not available.' }, 500);
    return c.json(sidecarManager.listSidecars());
});

app.post('/api/sidecars', async (c) => {
    if (!sidecarManager) return c.json({ error: 'Sidecar manager subsystem not available.' }, 500);
    try {
        const body = await c.req.json();
        const saved = await sidecarManager.saveSidecar(body);
        return c.json(saved);
    } catch (e) {
        return c.json({ error: e.message }, 400);
    }
});

app.post('/api/sidecars/:id/toggle', async (c) => {
    if (!sidecarManager) return c.json({ error: 'Sidecar manager subsystem not available.' }, 500);
    try {
        const id = c.req.param('id');
        const body = await c.req.json();
        const updated = await sidecarManager.toggleSidecar(id, body.enabled);
        return c.json(updated);
    } catch (e) {
        return c.json({ error: e.message }, 400);
    }
});

app.post('/api/sidecars/:id/run', async (c) => {
    if (!sidecarManager) return c.json({ error: 'Sidecar manager subsystem not available.' }, 500);
    try {
        const id = c.req.param('id');
        const result = await sidecarManager.triggerSidecar(id);
        return c.json(result);
    } catch (e) {
        return c.json({ error: e.message }, 400);
    }
});

app.get('/api/sidecars/:id/logs', (c) => {
    if (!sidecarManager) return c.json({ error: 'Sidecar manager subsystem not available.' }, 500);
    const id = c.req.param('id');
    const logs = sidecarManager.getLogs(id);
    return c.json({ logs });
});

app.delete('/api/sidecars/:id', async (c) => {
    if (!sidecarManager) return c.json({ error: 'Sidecar manager subsystem not available.' }, 500);
    try {
        const id = c.req.param('id');
        await sidecarManager.deleteSidecar(id);
        return c.json({ success: true });
    } catch (e) {
        return c.json({ error: e.message }, 400);
    }
});

app.get('/api/sidecars/:id', (c) => {
    if (!sidecarManager) return c.json({ error: 'Sidecar manager subsystem not available.' }, 500);
    const id = c.req.param('id');
    const s = sidecarManager.getSidecar(id);
    if (!s) return c.json({ error: 'Sidecar not found' }, 404);
    return c.json(s);
});

// REST: Models
app.get('/api/models', (c) => {
    if (!modelsManager) return c.json({ error: 'Models manager subsystem not available.' }, 500);
    return c.json(modelsManager.listProviders());
});

app.post('/api/models/test', async (c) => {
    if (!modelsManager) return c.json({ error: 'Models manager subsystem not available.' }, 500);
    try {
        const body = await c.req.json();
        const result = await modelsManager.testProvider(body);
        return c.json(result);
    } catch (e) {
        return c.json({ error: e.message }, 400);
    }
});

app.post('/api/models', async (c) => {
    if (!modelsManager) return c.json({ error: 'Models manager subsystem not available.' }, 500);
    try {
        const body = await c.req.json();
        const saved = modelsManager.saveProvider(body);
        return c.json({
            ...saved,
            apiKey: maskApiKey(saved.apiKey),
            hasKey: Boolean(saved.apiKey && saved.apiKey.trim().length > 0)
        });
    } catch (e) {
        return c.json({ error: e.message }, 400);
    }
});

app.delete('/api/models/:id', (c) => {
    if (!modelsManager) return c.json({ error: 'Models manager subsystem not available.' }, 500);
    try {
        const id = c.req.param('id');
        const deleted = modelsManager.deleteProvider(id);
        if (deleted) return c.json({ success: true });
        return c.json({ error: 'Provider not found' }, 404);
    } catch (e) {
        return c.json({ error: e.message }, 400);
    }
});

app.get('/api/models/:id', (c) => {
    if (!modelsManager) return c.json({ error: 'Models manager subsystem not available.' }, 500);
    const id = c.req.param('id');
    const p = modelsManager.getProvider(id);
    if (!p) return c.json({ error: 'Provider not found' }, 404);
    return c.json({
        ...p,
        apiKey: maskApiKey(p.apiKey),
        hasKey: Boolean(p.apiKey && p.apiKey.trim().length > 0)
    });
});

// Terminal routes
app.all('/terminal', (c) => {
    if (!ENABLE_TERMINAL) return c.text('Host Terminal is disabled (ENABLE_TERMINAL=false)', 404);
    return c.redirect('/terminal/', 302);
});

app.all('/terminal/*', (c) => {
    if (!ENABLE_TERMINAL) return c.text('Host Terminal is disabled (ENABLE_TERMINAL=false)', 404);
    const rawUrl = c.req.raw.url.replace(/^https?:\/\/[^/]+/, '');
    return proxyWebRequest(c, TERMINAL_PORT, rawUrl, { isTerminal: true });
});

// IDE routes
app.all('/ide', (c) => {
    if (!ENABLE_IDE) return c.text('Web IDE is disabled (ENABLE_IDE=false)', 404);
    return c.redirect('/ide/', 302);
});

app.all('/ide/*', (c) => {
    if (!ENABLE_IDE) return c.text('Web IDE is disabled (ENABLE_IDE=false)', 404);
    const rawUrl = c.req.raw.url.replace(/^https?:\/\/[^/]+/, '');
    const strippedPath = rawUrl.replace(/^\/ide/, '') || '/';
    return proxyWebRequest(c, IDE_PORT, strippedPath, { isIde: true });
});

// SPA check & Upstream Antigravity Hub proxy
app.all('*', (c) => {
    const pathname = c.req.path;
    if (c.req.method === 'GET' && isSpaRoute(pathname)) {
        if (c.req.query('useWebSocket') !== 'true') {
            const url = new URL(c.req.raw.url);
            url.searchParams.set('useWebSocket', 'true');
            return c.redirect(url.pathname + url.search, 302);
        }
    }

    if (!TARGET_PORT) {
        return c.html(renderStartingPage(), 503);
    }

    const rawUrl = c.req.raw.url.replace(/^https?:\/\/[^/]+/, '');
    return proxyWebRequest(c, TARGET_PORT, rawUrl, {
        isUpstream: true,
        sidecarManager,
        modelsManager
    });
});

setInterval(checkPortFile, 500);
checkPortFile();

if (sidecarManager) {
    sidecarManager.init().catch(err => {
        console.error('[Proxy Gateway] Failed to initialize Sidecar Manager:', err);
    });
}

let translationProxy = null;
const shouldStartTranslation = Boolean(
    TranslationProxy &&
    process.env.ENABLE_TRANSLATION_PROXY !== 'false' &&
    (process.env.ENABLE_TRANSLATION_PROXY === 'true' || (modelsManager && typeof modelsManager.hasEnabledModels === 'function' && modelsManager.hasEnabledModels()))
);

if (shouldStartTranslation) {
    translationProxy = new TranslationProxy({
        port: TRANSLATION_PORT,
        modelsManager,
        activeConversationModels
    });
    translationProxy.start().catch(err => {
        console.error('[Proxy Gateway] Warning: Translation Proxy failed to start:', err.message);
    });
}

const server = Bun.serve({
    port: LISTEN_PORT,
    hostname: '0.0.0.0',
    fetch(req, server) {
        if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
            if (!isAuthenticated(req)) {
                return new Response('Unauthorized', { status: 401 });
            }

            const url = new URL(req.url);
            let wsTargetPort = TARGET_PORT;
            let wsTargetPath = url.pathname + url.search;

            if (url.pathname.startsWith('/terminal')) {
                if (!ENABLE_TERMINAL) {
                    return new Response('Host Terminal is disabled (ENABLE_TERMINAL=false)', { status: 404 });
                }
                wsTargetPort = TERMINAL_PORT;
            } else if (url.pathname.startsWith('/ide')) {
                if (!ENABLE_IDE) {
                    return new Response('Web IDE is disabled (ENABLE_IDE=false)', { status: 404 });
                }
                wsTargetPort = IDE_PORT;
                wsTargetPath = wsTargetPath.replace(/^\/ide/, '') || '/';
            } else {
                if (!TARGET_PORT) {
                    return new Response('Service Unavailable', { status: 503 });
                }
                wsTargetPort = TARGET_PORT;
            }

            const safeWsPath = '/' + wsTargetPath.replace(/^\/+/, '');

            const success = server.upgrade(req, {
                data: {
                    wsTargetPort,
                    wsTargetPath: safeWsPath,
                    headers: Object.fromEntries(req.headers.entries())
                }
            });
            if (!success) {
                return new Response('WebSocket Upgrade Failed', { status: 400 });
            }
            return;
        }

        return app.fetch(req, { server });
    },
    websocket: {
        open(ws) {
            const { wsTargetPort, wsTargetPath, headers } = ws.data;
            const targetUrl = `ws://127.0.0.1:${wsTargetPort}${wsTargetPath}`;
            const upstreamHeaders = { ...headers };
            upstreamHeaders['host'] = `localhost:${wsTargetPort}`;
            upstreamHeaders['origin'] = `http://localhost:${wsTargetPort}`;
            if (upstreamHeaders['referer']) {
                upstreamHeaders['referer'] = upstreamHeaders['referer'].replace(/^https?:\/\/[^/]+/, `http://localhost:${wsTargetPort}`);
            }

            const isConnectWs = wsTargetPort === TARGET_PORT && typeof wsTargetPath === 'string' && wsTargetPath.startsWith('/connect-websocket');

            const subprotocols = headers['sec-websocket-protocol']
                ? headers['sec-websocket-protocol'].split(',').map(s => s.trim())
                : undefined;

            try {
                const upstreamWs = new WebSocket(targetUrl, {
                    headers: upstreamHeaders,
                    protocols: subprotocols
                });
                upstreamWs.binaryType = 'arraybuffer';
                ws.data.upstreamWs = upstreamWs;
                ws.data.pendingMessages = [];
                if (isConnectWs) {
                    ws.data.activeStreams = new Map();
                }

                upstreamWs.onopen = () => {
                    if (ws.data.pendingMessages && ws.data.pendingMessages.length > 0) {
                        for (const msg of ws.data.pendingMessages) {
                            upstreamWs.send(msg);
                        }
                        ws.data.pendingMessages = null;
                    }
                };

                upstreamWs.onmessage = (event) => {
                    try {
                        let dataToSend = event.data;
                        if (isConnectWs) {
                            dataToSend = handleWebSocketUpstreamMessage(ws, event, modelsManager);
                        }
                        ws.send(dataToSend);
                    } catch (e) {
                        try { ws.send(event.data); } catch (err) {}
                    }
                };

                upstreamWs.onclose = () => {
                    ws.data?.activeStreams?.clear();
                    try { ws.close(); } catch (e) {}
                };

                upstreamWs.onerror = () => {
                    ws.data?.activeStreams?.clear();
                    try { ws.close(); } catch (e) {}
                };
            } catch (err) {
                console.error('[WebSocket Bridge Error]', err.message);
                ws.close();
            }
        },
        message(ws, message) {
            let processedMessage = message;
            if (ws.data?.activeStreams) {
                processedMessage = handleWebSocketClientMessage(ws, message, modelsManager, activeConversationModels);
            }

            const upstreamWs = ws.data?.upstreamWs;
            if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
                upstreamWs.send(processedMessage);
            } else if (ws.data?.pendingMessages) {
                ws.data.pendingMessages.push(processedMessage);
            }
        },
        close(ws) {
            ws.data?.activeStreams?.clear();
            if (ws.data?.upstreamWs) {
                try { ws.data.upstreamWs.close(); } catch (e) {}
            }
        }
    }
});

console.log(`[Proxy Gateway] 🛡️  Listening on 0.0.0.0:${LISTEN_PORT} (Password Protection: ${AUTH_PASSWORD ? 'ENABLED' : 'DISABLED'})`);

export {
    app,
    server,
    setTargetPort,
    checkPortFile
};
