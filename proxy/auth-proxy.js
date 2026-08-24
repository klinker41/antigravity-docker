#!/usr/bin/env node

const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const url = require('node:url');
const fs = require('node:fs');

const LISTEN_PORT = parseInt(process.env.AGY_PORT || '4400', 10);
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const PORT_FILE = process.env.PORT_FILE || '/tmp/antigravity_port';
let TARGET_PORT = parseInt(process.env.INITIAL_TARGET_PORT || '0', 10);

// Generate expected auth token from password
function getExpectedToken() {
    if (!AUTH_PASSWORD) return '';
    return crypto.createHash('sha256').update(`antigravity_salt_${AUTH_PASSWORD}`).digest('hex');
}

const EXPECTED_TOKEN = getExpectedToken();

// Parse cookies helper
function parseCookies(req) {
    const list = {};
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return list;

    cookieHeader.split(';').forEach(cookie => {
        let [name, ...rest] = cookie.split('=');
        name = name?.trim();
        if (!name) return;
        const value = rest.join('=').trim();
        list[name] = decodeURIComponent(value);
    });
    return list;
}

// Check if request is authenticated
function isAuthenticated(req) {
    if (!AUTH_PASSWORD) return true; // No password configured -> open access
    const cookies = parseCookies(req);
    return cookies['antigravity_session'] === EXPECTED_TOKEN;
}

// Modern Dark Theme Login Page HTML
function renderLoginPage(error = '') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Antigravity Remote Access</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        body {
            background-color: #0e1117;
            color: #e6edf3;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 20px;
        }
        .card {
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 12px;
            padding: 32px;
            width: 100%;
            max-width: 400px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        }
        .header {
            text-align: center;
            margin-bottom: 24px;
        }
        .logo {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 52px;
            height: 52px;
            background: linear-gradient(135deg, #1a73e8, #8ab4f8);
            border-radius: 12px;
            margin-bottom: 14px;
            font-size: 26px;
        }
        h1 {
            font-size: 20px;
            font-weight: 600;
            color: #f0f6fc;
            margin-bottom: 6px;
        }
        p {
            font-size: 14px;
            color: #8b949e;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            font-size: 13px;
            font-weight: 500;
            margin-bottom: 8px;
            color: #c9d1d9;
        }
        input[type="password"] {
            width: 100%;
            padding: 10px 14px;
            background: #0d1117;
            border: 1px solid #30363d;
            border-radius: 6px;
            color: #f0f6fc;
            font-size: 14px;
            outline: none;
            transition: border-color 0.2s;
        }
        input[type="password"]:focus {
            border-color: #58a6ff;
            box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.2);
        }
        button {
            width: 100%;
            padding: 11px 16px;
            background: #238636;
            color: #ffffff;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: background-color 0.2s;
        }
        button:hover {
            background: #2ea043;
        }
        .error {
            background: rgba(248, 81, 73, 0.15);
            border: 1px solid rgba(248, 81, 73, 0.4);
            color: #ff7b72;
            padding: 10px;
            border-radius: 6px;
            font-size: 13px;
            margin-bottom: 16px;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="header">
            <div class="logo">🚀</div>
            <h1>Antigravity Remote Access</h1>
            <p>Enter your server access password</p>
        </div>
        ${error ? `<div class="error">${error}</div>` : ''}
        <form method="POST" action="/__auth/login">
            <div class="form-group">
                <label for="password">Password</label>
                <input type="password" id="password" name="password" required autofocus placeholder="Enter password...">
            </div>
            <button type="submit">Unlock Session</button>
        </form>
    </div>
</body>
</html>`;
}

// Create HTTP Proxy Server
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);

    // Handle Login POST
    if (parsedUrl.pathname === '/__auth/login' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            const params = new URLSearchParams(body);
            const enteredPassword = params.get('password') || '';

            if (enteredPassword === AUTH_PASSWORD) {
                // Set 30-day persistent cookie
                res.writeHead(302, {
                    'Set-Cookie': `antigravity_session=${EXPECTED_TOKEN}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`,
                    'Location': '/'
                });
                res.end();
            } else {
                res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(renderLoginPage('Incorrect password. Please try again.'));
            }
        });
        return;
    }

    // Check authentication
    if (!isAuthenticated(req)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderLoginPage());
        return;
    }

    // If target port is not ready yet
    if (!TARGET_PORT) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><body style="background:#0e1117;color:#e6edf3;font-family:sans-serif;text-align:center;padding-top:100px;">
            <h2>🚀 Antigravity Server Starting Up...</h2>
            <p style="color:#8b949e;margin-top:10px;">Please refresh in a few moments.</p>
        </body></html>`);
        return;
    }

    // Proxy HTTP Request with Host/Origin rewrite to localhost
    const proxyHeaders = { ...req.headers };
    proxyHeaders['host'] = `localhost:${TARGET_PORT}`;
    proxyHeaders['origin'] = `http://localhost:${TARGET_PORT}`;

    const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: TARGET_PORT,
        path: req.url,
        method: req.method,
        headers: proxyHeaders,
    }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
        console.error('[Proxy Error]', err.message);
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Antigravity upstream server unavailable.');
        }
    });

    req.pipe(proxyReq, { end: true });
});

// Handle WebSocket / Upgrade requests
server.on('upgrade', (req, clientSocket, head) => {
    if (!isAuthenticated(req)) {
        clientSocket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        clientSocket.destroy();
        return;
    }

    if (!TARGET_PORT) {
        clientSocket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        clientSocket.destroy();
        return;
    }

    const upstreamSocket = net.connect(TARGET_PORT, '127.0.0.1', () => {
        // Rewrite Host header in HTTP upgrade request
        let rawHeader = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (const [key, value] of Object.entries(req.headers)) {
            if (key.toLowerCase() === 'host') {
                rawHeader += `Host: localhost:${TARGET_PORT}\r\n`;
            } else if (key.toLowerCase() === 'origin') {
                rawHeader += `Origin: http://localhost:${TARGET_PORT}\r\n`;
            } else if (Array.isArray(value)) {
                for (const v of value) rawHeader += `${key}: ${v}\r\n`;
            } else {
                rawHeader += `${key}: ${value}\r\n`;
            }
        }
        rawHeader += '\r\n';

        upstreamSocket.write(rawHeader);
        if (head && head.length > 0) upstreamSocket.write(head);

        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
    });

    upstreamSocket.on('error', (err) => {
        console.error('[WebSocket Proxy Error]', err.message);
        clientSocket.destroy();
    });

    clientSocket.on('error', () => {
        upstreamSocket.destroy();
    });
});

// Update dynamic target port
function setTargetPort(port) {
    TARGET_PORT = parseInt(port, 10);
    console.log(`[Proxy Gateway] 🔗 Bridged port ${LISTEN_PORT} -> http://127.0.0.1:${TARGET_PORT}`);
}

// Watch port file for dynamic port detection
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

setInterval(checkPortFile, 500);
checkPortFile();

server.listen(LISTEN_PORT, '0.0.0.0', () => {
    console.log(`[Proxy Gateway] 🛡️  Listening on 0.0.0.0:${LISTEN_PORT} (Password Protection: ${AUTH_PASSWORD ? 'ENABLED' : 'DISABLED'})`);
});
