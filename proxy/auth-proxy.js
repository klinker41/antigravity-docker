#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { LISTEN_PORT, AGY_HUB_PORT, AUTH_PASSWORD, PORT_FILE, ENABLE_TERMINAL, ENABLE_IDE } = require('./lib/config');
const { isAuthenticated, activeSessions, loginRateLimiter, parseCookies, getClientIp, checkRateLimit, recordFailedAttempt, SESSION_TTL_MS } = require('./lib/session');
const { safeCompare, applySecurityHeaders, readRequestBody, readJsonBody } = require('./lib/security');
const { isFaviconRequest, handleFaviconRequest } = require('./lib/favicon');
const { renderLoginPage, renderStatusPage, renderStartingPage, renderSidecarsPage, checkUpstreamHealth } = require('./lib/pages');
const { proxyToTerminal, proxyToIde, isSpaRoute, proxyToUpstream, handleWebSocketUpgrade } = require('./lib/proxy');

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

let TARGET_PORT = AGY_HUB_PORT;
if (sidecarManager && TARGET_PORT) {
    sidecarManager.setLsAddress(`127.0.0.1:${TARGET_PORT}`);
}

// Update dynamic target port
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

// Check port file for dynamic port overrides if present
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

// Create HTTP Proxy Server
const server = http.createServer(async (req, res) => {
    try {
        applySecurityHeaders(res, req);
        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        // 0. Handle Favicons & App Icons (ALWAYS UNAUTHENTICATED)
        if (isFaviconRequest(parsedUrl.pathname)) {
            handleFaviconRequest(req, res, parsedUrl.pathname);
            return;
        }

        // 1. Handle /status health check endpoint (ALWAYS UNAUTHENTICATED)
        if (parsedUrl.pathname === '/status' || parsedUrl.pathname === '/status/') {
            checkPortFile();
            const health = await checkUpstreamHealth(TARGET_PORT);
            const statusCode = health.up ? 200 : 503;

            const wantsJson = req.headers.accept?.includes('application/json') || parsedUrl.searchParams.get('format') === 'json';
            if (wantsJson) {
                res.writeHead(statusCode, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-cache, no-store, must-revalidate'
                });
                res.end(JSON.stringify({ status: health.up ? 'ok' : 'error' }, null, 2));
                return;
            }

            res.writeHead(statusCode, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
            res.end(renderStatusPage(health));
            return;
        }

        // 2. Handle Logout GET or POST
        if (parsedUrl.pathname === '/__auth/logout') {
            const cookies = parseCookies(req);
            if (cookies['antigravity_session']) {
                activeSessions.delete(cookies['antigravity_session']);
            }
            res.writeHead(302, {
                'Set-Cookie': 'antigravity_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
                'Location': '/__auth/login'
            });
            res.end();
            return;
        }

        // 3. Handle Login POST
        if (parsedUrl.pathname === '/__auth/login' && req.method === 'POST') {
            const clientIp = getClientIp(req);
            const rateCheck = checkRateLimit(clientIp);

            if (!rateCheck.allowed) {
                res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(renderLoginPage(rateCheck.message));
                return;
            }

            try {
                const body = await readRequestBody(req, 16 * 1024);
                const params = new URLSearchParams(body);
                const enteredPassword = params.get('password') || '';

                if (AUTH_PASSWORD && safeCompare(enteredPassword, AUTH_PASSWORD)) {
                    loginRateLimiter.delete(clientIp);

                    const sessionToken = crypto.randomBytes(32).toString('hex');
                    const now = Date.now();
                    activeSessions.set(sessionToken, {
                        createdAt: now,
                        expiresAt: now + SESSION_TTL_MS
                    });

                    const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
                    const secureFlag = isHttps ? '; Secure' : '';

                    res.writeHead(302, {
                        'Set-Cookie': `antigravity_session=${sessionToken}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secureFlag}`,
                        'Location': '/?useWebSocket=true'
                    });
                    res.end();
                } else {
                    recordFailedAttempt(clientIp);
                    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(renderLoginPage('Incorrect password. Please try again.'));
                }
            } catch (err) {
                if (err.message === 'Payload Too Large') {
                    res.writeHead(413, { 'Content-Type': 'text/plain' });
                    res.end('Payload Too Large');
                } else {
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('Bad Request');
                }
            }
            return;
        }

        // 4. Check Authentication for ALL other routes (/sidecars, /ide, /terminal, /, /api/*, etc.)
        if (!isAuthenticated(req)) {
            if (parsedUrl.pathname.startsWith('/api/')) {
                res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: 'Unauthorized. Please sign in.' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderLoginPage());
            return;
        }

        // 5. Handle /sidecars UI route (AUTHENTICATED)
        if (parsedUrl.pathname === '/sidecars' || parsedUrl.pathname === '/sidecars/') {
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
            res.end(renderSidecarsPage());
            return;
        }

        // 6. Handle /api/projects REST endpoint (AUTHENTICATED)
        if (parsedUrl.pathname === '/api/projects' && req.method === 'GET') {
            const projects = sidecarManager ? sidecarManager.listProjects() : [];
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(projects));
            return;
        }

        // 7. Handle /api/sidecars* REST endpoints (AUTHENTICATED)
        if (parsedUrl.pathname === '/api/sidecars' || parsedUrl.pathname.startsWith('/api/sidecars/')) {
            if (!sidecarManager) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: 'Sidecar manager subsystem not available.' }));
                return;
            }

            // GET /api/sidecars -> List all
            if (parsedUrl.pathname === '/api/sidecars' && req.method === 'GET') {
                const sidecars = sidecarManager.listSidecars();
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(sidecars));
                return;
            }

            // POST /api/sidecars -> Save/create
            if (parsedUrl.pathname === '/api/sidecars' && req.method === 'POST') {
                try {
                    const body = await readJsonBody(req);
                    const saved = await sidecarManager.saveSidecar(body);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify(saved));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: e.message }));
                }
                return;
            }

            // Route matching: /api/sidecars/:id/...
            const subPath = parsedUrl.pathname.replace(/^\/api\/sidecars\/?/, '');
            const parts = subPath.split('/');
            const sidecarId = decodeURIComponent(parts[0]);
            const action = parts[1];

            // POST /api/sidecars/:id/toggle
            if (action === 'toggle' && req.method === 'POST') {
                try {
                    const body = await readJsonBody(req);
                    const updated = await sidecarManager.toggleSidecar(sidecarId, body.enabled);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify(updated));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: e.message }));
                }
                return;
            }

            // POST /api/sidecars/:id/run
            if (action === 'run' && req.method === 'POST') {
                try {
                    const result = await sidecarManager.triggerSidecar(sidecarId);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify(result));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: e.message }));
                }
                return;
            }

            // GET /api/sidecars/:id/logs
            if (action === 'logs' && req.method === 'GET') {
                const logs = sidecarManager.getLogs(sidecarId);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ logs }));
                return;
            }

            // DELETE /api/sidecars/:id
            if (!action && req.method === 'DELETE') {
                try {
                    await sidecarManager.deleteSidecar(sidecarId);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: e.message }));
                }
                return;
            }

            // GET /api/sidecars/:id
            if (!action && req.method === 'GET') {
                const s = sidecarManager.getSidecar(sidecarId);
                if (!s) {
                    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: 'Sidecar not found' }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify(s));
                }
                return;
            }
        }

        // 8. Handle /terminal and /terminal/* routes
        if (parsedUrl.pathname === '/terminal' || parsedUrl.pathname.startsWith('/terminal/')) {
            if (!ENABLE_TERMINAL) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Host Terminal is disabled (ENABLE_TERMINAL=false)');
                return;
            }
            if (parsedUrl.pathname === '/terminal') {
                res.writeHead(302, { 'Location': '/terminal/' });
                res.end();
                return;
            }
            proxyToTerminal(req, res, req.url);
            return;
        }

        // 9. Handle /ide and /ide/* routes
        if (parsedUrl.pathname === '/ide' || parsedUrl.pathname.startsWith('/ide/')) {
            if (!ENABLE_IDE) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Web IDE is disabled (ENABLE_IDE=false)');
                return;
            }
            if (parsedUrl.pathname === '/ide') {
                res.writeHead(302, { 'Location': '/ide/' });
                res.end();
                return;
            }
            const strippedPath = req.url.replace(/^\/ide/, '') || '/';
            proxyToIde(req, res, strippedPath);
            return;
        }

        // 10. Ensure useWebSocket=true query param is present for all browser SPA routes
        if (req.method === 'GET' && isSpaRoute(parsedUrl.pathname)) {
            if (parsedUrl.searchParams.get('useWebSocket') !== 'true') {
                parsedUrl.searchParams.set('useWebSocket', 'true');
                res.writeHead(302, {
                    'Location': `${parsedUrl.pathname}${parsedUrl.search}`
                });
                res.end();
                return;
            }
        }

        // 11. If target port is not ready yet
        if (!TARGET_PORT) {
            res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderStartingPage());
            return;
        }

        // 12. Proxy HTTP Request to Antigravity agy with DOM injection on HTML responses
        proxyToUpstream(req, res, TARGET_PORT, sidecarManager);
    } catch (err) {
        console.error('[HTTP Gateway Error]', err);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Gateway Error');
        } else {
            res.destroy();
        }
    }
});

// Handle WebSocket / Upgrade requests
server.on('upgrade', (req, clientSocket, head) => {
    if (!isAuthenticated(req)) {
        clientSocket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        clientSocket.destroy();
        return;
    }
    handleWebSocketUpgrade(req, clientSocket, head, TARGET_PORT);
});

setInterval(checkPortFile, 500);
checkPortFile();

// Initialize Sidecar subsystem
if (sidecarManager) {
    sidecarManager.init().catch(err => {
        console.error('[Proxy Gateway] Failed to initialize Sidecar Manager:', err);
    });
}

server.listen(LISTEN_PORT, '0.0.0.0', () => {
    console.log(`[Proxy Gateway] 🛡️  Listening on 0.0.0.0:${LISTEN_PORT} (Password Protection: ${AUTH_PASSWORD ? 'ENABLED' : 'DISABLED'})`);
});
