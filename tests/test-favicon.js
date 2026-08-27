const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

test('Favicon & App Icon Management', async (t) => {
    const TEST_PROXY_PORT = 16677;
    const TEST_TARGET_PORT = 16678;
    const TEST_TERMINAL_PORT = 16679;
    const TEST_IDE_PORT = 16680;
    const TEST_PASSWORD = 'test-favicon-password';

    // Mock upstream AGY server
    const mockAgyServer = http.createServer((req, res) => {
        if (req.url.startsWith('/?useWebSocket=true') || req.url === '/' || req.url === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Antigravity</title><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎁</text></svg>"/></head><body><div id="root">Antigravity UI</div></body></html>`);
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('AGY Upstream OK');
    });

    // Mock upstream ttyd server
    const mockTerminalServer = http.createServer((req, res) => {
        if (req.url === '/terminal/' || req.url === '/terminal') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!DOCTYPE html><html><head><title>ttyd - Terminal</title><link rel="icon" type="image/png" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."></head><body><div id="terminal"></div></body></html>`);
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    });

    // Mock upstream code-server
    const mockIdeServer = http.createServer((req, res) => {
        if (req.url === '/' || req.url.startsWith('/?')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!DOCTYPE html><html><head><title>code-server</title><link rel="icon" href="./_static/src/browser/media/favicon-dark-support.svg" /><link rel="alternate icon" href="./_static/src/browser/media/favicon.ico" type="image/x-icon" /></head><body><div id="workbench"></div></body></html>`);
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('IDE Upstream OK');
    });

    await new Promise((resolve) => mockAgyServer.listen(TEST_TARGET_PORT, '127.0.0.1', resolve));
    await new Promise((resolve) => mockTerminalServer.listen(TEST_TERMINAL_PORT, '127.0.0.1', resolve));
    await new Promise((resolve) => mockIdeServer.listen(TEST_IDE_PORT, '127.0.0.1', resolve));

    // Spawn proxy instance with test ports
    const proxyProc = spawn(process.execPath, [path.join(__dirname, '../proxy/auth-proxy.js')], {
        env: {
            ...process.env,
            AGY_PORT: String(TEST_PROXY_PORT),
            AUTH_PASSWORD: TEST_PASSWORD,
            INITIAL_TARGET_PORT: String(TEST_TARGET_PORT),
            TERMINAL_PORT: String(TEST_TERMINAL_PORT),
            IDE_PORT: String(TEST_IDE_PORT),
            ENABLE_IDE: 'true',
            ENABLE_TERMINAL: 'true'
        },
        stdio: 'pipe'
    });

    await new Promise((resolve) => {
        proxyProc.stdout.on('data', (d) => {
            if (d.toString().includes('Listening on')) resolve();
        });
        setTimeout(resolve, 1500);
    });

    function makeRequest(reqPath, options = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: TEST_PROXY_PORT,
                path: reqPath,
                method: options.method || 'GET',
                headers: options.headers || {}
            }, (res) => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf8'),
                    buffer: Buffer.concat(chunks)
                }));
            });
            req.on('error', reject);
            if (options.body) req.write(options.body);
            req.end();
        });
    }

    try {
        await t.test('serves favicon.svg directly without authentication', async () => {
            const res = await makeRequest('/favicon.svg');
            assert.equal(res.status, 200);
            assert.ok(res.headers['content-type'].includes('image/svg+xml'));
            assert.ok(res.headers['cache-control'].includes('public'));
            assert.ok(res.body.includes('<svg'));
            assert.ok(res.body.includes('brand-grad'));
        });

        await t.test('serves favicon.ico directly without authentication', async () => {
            const res = await makeRequest('/favicon.ico');
            assert.equal(res.status, 200);
            assert.equal(res.headers['content-type'], 'image/x-icon');
            assert.ok(res.headers['cache-control'].includes('public'));
            assert.ok(res.buffer.length > 0);
        });

        await t.test('serves favicon.png and apple-touch-icon.png directly without authentication', async () => {
            const resPng = await makeRequest('/favicon.png');
            assert.equal(resPng.status, 200);
            assert.equal(resPng.headers['content-type'], 'image/png');
            assert.ok(resPng.buffer.length > 0);

            const resTouch = await makeRequest('/apple-touch-icon.png');
            assert.equal(resTouch.status, 200);
            assert.equal(resTouch.headers['content-type'], 'image/png');
            assert.ok(resTouch.buffer.length > 0);

            const resTouchPre = await makeRequest('/apple-touch-icon-precomposed.png');
            assert.equal(resTouchPre.status, 200);
            assert.equal(resTouchPre.headers['content-type'], 'image/png');
        });

        await t.test('serves terminal and IDE favicon subpaths directly without authentication', async () => {
            const resTermIco = await makeRequest('/terminal/favicon.ico');
            assert.equal(resTermIco.status, 200);
            assert.equal(resTermIco.headers['content-type'], 'image/x-icon');

            const resTermSvg = await makeRequest('/terminal/favicon.svg');
            assert.equal(resTermSvg.status, 200);
            assert.ok(resTermSvg.headers['content-type'].includes('image/svg+xml'));

            const resIdeIco = await makeRequest('/ide/favicon.ico');
            assert.equal(resIdeIco.status, 200);
            assert.equal(resIdeIco.headers['content-type'], 'image/x-icon');

            const resIdeSvg = await makeRequest('/ide/_static/src/browser/media/favicon.svg');
            assert.equal(resIdeSvg.status, 200);
            assert.ok(resIdeSvg.headers['content-type'].includes('image/svg+xml'));

            const resIdeDarkSvg = await makeRequest('/ide/_static/src/browser/media/favicon-dark-support.svg');
            assert.equal(resIdeDarkSvg.status, 200);
            assert.ok(resIdeDarkSvg.headers['content-type'].includes('image/svg+xml'));

            const resPwa192 = await makeRequest('/ide/_static/src/browser/media/pwa-icon-192.png');
            assert.equal(resPwa192.status, 200);
            assert.equal(resPwa192.headers['content-type'], 'image/png');

            const resPwa512 = await makeRequest('/ide/_static/src/browser/media/pwa-icon-512.png');
            assert.equal(resPwa512.status, 200);
            assert.equal(resPwa512.headers['content-type'], 'image/png');
        });

        await t.test('includes favicon links on /status and /__auth/login pages', async () => {
            const resStatus = await makeRequest('/status');
            assert.equal(resStatus.status, 200);
            assert.ok(resStatus.body.includes('<link rel="icon" type="image/svg+xml" href="/favicon.svg">'));
            assert.ok(resStatus.body.includes('<link rel="alternate icon" href="/favicon.ico">'));
            assert.ok(resStatus.body.includes('<link rel="apple-touch-icon" href="/apple-touch-icon.png">'));

            const resLogin = await makeRequest('/__auth/login');
            assert.equal(resLogin.status, 200);
            assert.ok(resLogin.body.includes('<link rel="icon" type="image/svg+xml" href="/favicon.svg">'));
            assert.ok(resLogin.body.includes('<link rel="alternate icon" href="/favicon.ico">'));
        });

        await t.test('includes favicon links on authenticated /sidecars page', async () => {
            // Login to obtain session cookie
            const loginRes = await makeRequest('/__auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `password=${TEST_PASSWORD}`
            });
            const setCookie = loginRes.headers['set-cookie']?.[0] || '';
            const match = setCookie.match(/antigravity_session=([^;]+)/);
            assert.ok(match, 'Session cookie must be set');
            const sessionToken = match[1];

            const resSidecars = await makeRequest('/sidecars', {
                headers: { 'Cookie': `antigravity_session=${sessionToken}` }
            });
            assert.equal(resSidecars.status, 200);
            assert.ok(resSidecars.body.includes('<link rel="icon" type="image/svg+xml" href="/favicon.svg">'));
            assert.ok(resSidecars.body.includes('<link rel="alternate icon" href="/favicon.ico">'));
        });

        await t.test('overrides default upstream emoji favicon in Antigravity Web UI HTML', async () => {
            // Login first
            const loginRes = await makeRequest('/__auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `password=${TEST_PASSWORD}`
            });
            const cookie = loginRes.headers['set-cookie']?.[0]?.split(';')[0] || '';

            const res = await makeRequest('/?useWebSocket=true', {
                headers: { 'Cookie': cookie }
            });
            assert.equal(res.status, 200);
            assert.equal(res.body.includes('🎁'), false, 'Default gift emoji favicon must be removed');
            assert.ok(res.body.includes('<link rel="icon" type="image/svg+xml" href="/favicon.svg">'));
            assert.ok(res.body.includes('<link rel="alternate icon" href="/favicon.ico">'));
            assert.ok(res.body.includes('enforceFavicon'));
        });

        await t.test('overrides ttyd default favicon and sets title in Web Terminal HTML', async () => {
            const loginRes = await makeRequest('/__auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `password=${TEST_PASSWORD}`
            });
            const cookie = loginRes.headers['set-cookie']?.[0]?.split(';')[0] || '';

            const res = await makeRequest('/terminal/', {
                headers: { 'Cookie': cookie }
            });
            assert.equal(res.status, 200);
            assert.equal(res.body.includes('data:image/png;base64'), false, 'ttyd default inline PNG icon must be removed');
            assert.ok(res.body.includes('<link rel="icon" type="image/svg+xml" href="/favicon.svg">'));
            assert.ok(res.body.includes('<link rel="alternate icon" href="/favicon.ico">'));
            assert.ok(res.body.includes('<title>Antigravity Terminal</title>'));
        });

        await t.test('overrides code-server default favicon in Web IDE HTML', async () => {
            const loginRes = await makeRequest('/__auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `password=${TEST_PASSWORD}`
            });
            const cookie = loginRes.headers['set-cookie']?.[0]?.split(';')[0] || '';

            const res = await makeRequest('/ide/?folder=/workspace', {
                headers: { 'Cookie': cookie }
            });
            assert.equal(res.status, 200);
            assert.equal(res.body.includes('./_static/src/browser/media/favicon-dark-support.svg'), false);
            assert.ok(res.body.includes('<link rel="icon" type="image/svg+xml" href="/favicon.svg">'));
            assert.ok(res.body.includes('<link rel="alternate icon" href="/favicon.ico">'));
        });

    } finally {
        proxyProc.kill('SIGKILL');
        mockAgyServer.close();
        mockTerminalServer.close();
        mockIdeServer.close();
    }
});
