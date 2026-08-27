'use strict';

const http = require('node:http');
const { TERMINAL_PORT, IDE_PORT, ENABLE_IDE, ENABLE_TERMINAL } = require('./config');
const { replaceFaviconInHtml } = require('./favicon');
const { renderServiceStartingPage } = require('./pages');
const { INJECTED_UI_STYLES, buildInjectedScript } = require('./ui-injection');

// Hop-by-hop headers defined in RFC 7230 / RFC 9110 to strip when proxying
const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'transfer-encoding',
    'upgrade',
]);

// Dedicated persistent HTTP Agent for upstream proxy requests
const proxyAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 256,
    maxFreeSockets: 64,
    timeout: 0
});

// Strip hop-by-hop headers from an incoming headers object
function filterHopByHop(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
            out[key] = value;
        }
    }
    return out;
}

// Buffer an HTML response, apply a transform, then send it.
// Owns the res.writeHead() call to ensure Content-Length is correct after
// transformation. Falls back to streaming if the response exceeds MAX_HTML_BUFFER_BYTES.
function interceptHtmlResponse(proxyRes, res, statusCode, resHeaders, transform) {
    const MAX_HTML_BUFFER_BYTES = 5 * 1024 * 1024;
    const chunks = [];
    let totalLength = 0;
    let tooLarge = false;

    proxyRes.on('data', (chunk) => {
        if (tooLarge) {
            res.write(chunk);
            return;
        }
        totalLength += chunk.length;
        if (totalLength > MAX_HTML_BUFFER_BYTES) {
            tooLarge = true;
            // Headers not yet sent — write them now before streaming
            res.writeHead(statusCode, resHeaders);
            res.flushHeaders();
            for (const c of chunks) res.write(c);
            res.write(chunk);
            return;
        }
        chunks.push(chunk);
    });

    proxyRes.on('end', () => {
        if (tooLarge) {
            res.end();
            return;
        }
        let html = Buffer.concat(chunks).toString('utf8');
        html = transform(html);
        // Update content-length to reflect transformed HTML size, then send
        resHeaders['content-length'] = Buffer.byteLength(html, 'utf8');
        delete resHeaders['content-encoding'];
        res.writeHead(statusCode, resHeaders);
        res.end(html);
    });
}

// Forward request to ttyd Web Terminal
function proxyToTerminal(req, res, targetPath) {
    if (req.socket) req.socket.setNoDelay(true);
    if (res.socket) res.socket.setNoDelay(true);

    const proxyHeaders = filterHopByHop(req.headers);
    proxyHeaders['host'] = `localhost:${TERMINAL_PORT}`;
    proxyHeaders['origin'] = `http://localhost:${TERMINAL_PORT}`;

    // Request uncompressed body only for top-level HTML requests to preserve compression on web assets
    const wantsHtml = (req.headers.accept || '').includes('text/html') || targetPath === '/' || targetPath === '/terminal' || targetPath === '/terminal/';
    if (wantsHtml) {
        proxyHeaders['accept-encoding'] = 'identity';
    }

    const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: TERMINAL_PORT,
        path: targetPath,
        method: req.method,
        headers: proxyHeaders,
        agent: proxyAgent
    }, (proxyRes) => {
        if (proxyRes.socket) proxyRes.socket.setNoDelay(true);

        const resHeaders = filterHopByHop(proxyRes.headers);
        resHeaders['x-accel-buffering'] = 'no';

        const encoding = resHeaders['content-encoding'];
        const isUncompressed = !encoding || encoding === 'identity';
        const isHtmlResponse = (resHeaders['content-type'] || '').includes('text/html') && isUncompressed;
        if (isHtmlResponse && req.method === 'GET') {
            interceptHtmlResponse(proxyRes, res, proxyRes.statusCode, resHeaders, (html) => {
                html = replaceFaviconInHtml(html);
                html = html.replace(/<title>ttyd - Terminal<\/title>/i, '<title>Antigravity Terminal</title>');
                return html;
            });
            return;
        }

        res.writeHead(proxyRes.statusCode, resHeaders);
        res.flushHeaders();
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        if (!res.headersSent) {
            res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderServiceStartingPage('Host Terminal'));
        } else {
            res.destroy();
        }
    });

    req.pipe(proxyReq, { end: true });
}

// Forward request to code-server Web IDE
function proxyToIde(req, res, targetPath) {
    if (req.socket) req.socket.setNoDelay(true);
    if (res.socket) res.socket.setNoDelay(true);

    const proxyHeaders = filterHopByHop(req.headers);
    proxyHeaders['host'] = `localhost:${IDE_PORT}`;
    proxyHeaders['origin'] = `http://localhost:${IDE_PORT}`;

    // Request uncompressed body only for top-level HTML requests to preserve gzip/brotli on IDE bundles
    const wantsHtml = (req.headers.accept || '').includes('text/html') || targetPath === '/' || targetPath.startsWith('/?');
    if (wantsHtml) {
        proxyHeaders['accept-encoding'] = 'identity';
    }

    const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: IDE_PORT,
        path: targetPath,
        method: req.method,
        headers: proxyHeaders,
        agent: proxyAgent
    }, (proxyRes) => {
        if (proxyRes.socket) proxyRes.socket.setNoDelay(true);

        const resHeaders = filterHopByHop(proxyRes.headers);

        // Rewrite Location headers to stay under the /ide prefix
        if (resHeaders['location'] && typeof resHeaders['location'] === 'string') {
            if (resHeaders['location'].startsWith('/')) {
                resHeaders['location'] = '/ide' + resHeaders['location'];
            }
        }
        resHeaders['x-accel-buffering'] = 'no';

        const encoding = resHeaders['content-encoding'];
        const isUncompressed = !encoding || encoding === 'identity';
        const isHtmlResponse = (resHeaders['content-type'] || '').includes('text/html') && isUncompressed;
        if (isHtmlResponse && req.method === 'GET') {
            interceptHtmlResponse(proxyRes, res, proxyRes.statusCode, resHeaders, replaceFaviconInHtml);
            return;
        }

        res.writeHead(proxyRes.statusCode, resHeaders);
        res.flushHeaders();
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        if (!res.headersSent) {
            res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderServiceStartingPage('Web IDE'));
        } else {
            res.destroy();
        }
    });

    req.pipe(proxyReq, { end: true });
}

// Helper to determine if a request path corresponds to a browser SPA frontend route
function isSpaRoute(pathname) {
    if (pathname === '/' || pathname === '/index.html') return true;
    if (pathname.startsWith('/c/') || pathname === '/c') return true;
    if (pathname.startsWith('/history')) return true;
    if (pathname.startsWith('/projects')) return true;
    if (pathname.startsWith('/tasks')) return true;
    return false;
}

// Proxy HTTP request to the main Antigravity upstream (agy), injecting tools UI on HTML responses
function proxyToUpstream(req, res, targetPort, sidecarManager) {
    if (req.socket) req.socket.setNoDelay(true);
    if (res.socket) res.socket.setNoDelay(true);

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    const proxyHeaders = filterHopByHop(req.headers);
    proxyHeaders['host'] = `localhost:${targetPort}`;
    proxyHeaders['origin'] = `http://localhost:${targetPort}`;
    if (req.headers['referer']) {
        proxyHeaders['referer'] = req.headers['referer'].replace(/^https?:\/\/[^/]+/, `http://localhost:${targetPort}`);
    }

    // Request uncompressed body only for SPA document routes and HTML requests to preserve compression
    if (isSpaRoute(parsedUrl.pathname) || (req.headers.accept || '').includes('text/html')) {
        proxyHeaders['accept-encoding'] = 'identity';
    }

    const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: proxyHeaders,
        agent: proxyAgent,
    }, (proxyRes) => {
        if (proxyRes.socket) proxyRes.socket.setNoDelay(true);

        const resHeaders = filterHopByHop(proxyRes.headers);

        const allowedOrigins = process.env.ALLOWED_ORIGINS
            ? new Set(process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()))
            : null;
        if (resHeaders['access-control-allow-origin'] && req.headers.origin) {
            if (allowedOrigins && allowedOrigins.has(req.headers.origin)) {
                resHeaders['access-control-allow-origin'] = req.headers.origin;
            } else if (!allowedOrigins) {
                delete resHeaders['access-control-allow-origin'];
            }
        }

        resHeaders['x-accel-buffering'] = 'no';

        const encoding = resHeaders['content-encoding'];
        const isUncompressed = !encoding || encoding === 'identity';
        const isHtmlResponse = (resHeaders['content-type'] || '').includes('text/html') && isUncompressed;

        // INTERCEPT HTML RESPONSES TO INJECT WORKSPACE TOOLS BUTTONS AND OVERRIDE FAVICON
        if (isHtmlResponse && req.method === 'GET') {
            interceptHtmlResponse(proxyRes, res, proxyRes.statusCode, resHeaders, (html) => {
                const csrfMatch = html.match(/"csrfToken":"([^"]+)"/);
                if (csrfMatch && sidecarManager) {
                    sidecarManager.setCsrfToken(csrfMatch[1]);
                }

                // Remove existing upstream/emoji favicon tags and inject Antigravity favicon
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
                return html;
            });
            return;
        }

        res.writeHead(proxyRes.statusCode, resHeaders);
        res.flushHeaders();
        proxyRes.pipe(res);
    });

    proxyReq.on('socket', (sock) => {
        sock.setNoDelay(true);
    });

    const clientAbortHandler = () => {
        if (!res.writableFinished && !res.writableEnded && !proxyReq.destroyed) {
            proxyReq.destroy();
        }
    };

    res.on('close', clientAbortHandler);
    res.on('error', clientAbortHandler);
    req.on('error', clientAbortHandler);

    proxyReq.on('error', (err) => {
        console.error('[HTTP Proxy Error]', err.message);
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Antigravity upstream server unavailable.');
        } else {
            res.destroy();
        }
    });

    req.pipe(proxyReq, { end: true });
}

// Handle WebSocket / Upgrade requests
function handleWebSocketUpgrade(req, clientSocket, head, targetPort) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let wsTargetPort = targetPort;
    let wsTargetPath = req.url;

    if (parsedUrl.pathname.startsWith('/terminal')) {
        if (!ENABLE_TERMINAL) {
            clientSocket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            clientSocket.destroy();
            return;
        }
        wsTargetPort = TERMINAL_PORT;
        wsTargetPath = req.url;
    } else if (parsedUrl.pathname.startsWith('/ide')) {
        if (!ENABLE_IDE) {
            clientSocket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            clientSocket.destroy();
            return;
        }
        wsTargetPort = IDE_PORT;
        wsTargetPath = req.url.replace(/^\/ide/, '') || '/';
    } else {
        if (!targetPort) {
            clientSocket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
            clientSocket.destroy();
            return;
        }
        wsTargetPort = targetPort;
    }

    clientSocket.setNoDelay(true);

    const proxyHeaders = { ...req.headers };
    proxyHeaders['host'] = `localhost:${wsTargetPort}`;
    proxyHeaders['origin'] = `http://localhost:${wsTargetPort}`;
    if (proxyHeaders['referer']) {
        proxyHeaders['referer'] = proxyHeaders['referer'].replace(/^https?:\/\/[^/]+/, `http://localhost:${wsTargetPort}`);
    }

    const upstreamReq = http.request({
        hostname: '127.0.0.1',
        port: wsTargetPort,
        path: wsTargetPath,
        method: req.method,
        headers: proxyHeaders,
        agent: false,
    });

    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
        upstreamSocket.setNoDelay(true);

        let rawResponse = `HTTP/1.1 101 Switching Protocols\r\n`;
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (Array.isArray(value)) {
                for (const v of value) rawResponse += `${key}: ${v}\r\n`;
            } else {
                rawResponse += `${key}: ${value}\r\n`;
            }
        }
        rawResponse += '\r\n';

        clientSocket.write(rawResponse);
        if (upstreamHead && upstreamHead.length > 0) clientSocket.write(upstreamHead);
        if (head && head.length > 0) upstreamSocket.write(head);

        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);

        const cleanup = () => {
            upstreamSocket.destroy();
            clientSocket.destroy();
        };

        upstreamSocket.on('error', cleanup);
        clientSocket.on('error', cleanup);
        upstreamSocket.on('close', cleanup);
        clientSocket.on('close', cleanup);
        upstreamSocket.on('end', () => clientSocket.end());
        clientSocket.on('end', () => upstreamSocket.end());
    });

    upstreamReq.on('response', (upstreamRes) => {
        let rawResponse = `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage || ''}\r\n`;
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (Array.isArray(value)) {
                for (const v of value) rawResponse += `${key}: ${v}\r\n`;
            } else {
                rawResponse += `${key}: ${value}\r\n`;
            }
        }
        rawResponse += '\r\n';
        clientSocket.write(rawResponse);
        upstreamRes.pipe(clientSocket);
    });

    upstreamReq.on('error', (err) => {
        console.error('[WebSocket Upgrade Error]', err.message);
        clientSocket.destroy();
    });

    upstreamReq.end();
}

module.exports = {
    proxyToTerminal,
    proxyToIde,
    isSpaRoute,
    proxyToUpstream,
    handleWebSocketUpgrade,
};
