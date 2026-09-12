const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

const { TranslationProxy } = require('../proxy/translation-proxy');

test('Translation Proxy - Server Lifecycle & Transparent Pass-Through', async (t) => {
    // 1. Create a mock upstream representing Google CloudCode
    let upstreamReceived = null;
    const mockGoogleUpstream = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            upstreamReceived = {
                method: req.method,
                url: req.url,
                headers: req.headers,
                body
            };
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'X-Mock-Upstream': 'Google-CloudCode'
            });
            res.end(JSON.stringify({ status: 'ok', mock: true }));
        });
    });

    await new Promise((resolve) => mockGoogleUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = mockGoogleUpstream.address().port;

    // 2. Initialize TranslationProxy targeting mock upstream
    const proxyPort = upstreamPort + 10;
    const proxy = new TranslationProxy({
        port: proxyPort,
        upstreamUrl: `http://127.0.0.1:${upstreamPort}`
    });

    await proxy.start();

    t.after(async () => {
        await proxy.stop();
        mockGoogleUpstream.close();
    });

    await t.test('passes standard requests through to upstream transparently', async () => {
        const testPayload = JSON.stringify({ model: 'gemini-3.8-flash', prompt: 'test' });
        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: proxyPort,
                path: '/v1internal:loadCodeAssist',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer test-oauth-token',
                    'Content-Length': Buffer.byteLength(testPayload)
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: data
                }));
            });
            req.on('error', reject);
            req.write(testPayload);
            req.end();
        });

        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['x-mock-upstream'], 'Google-CloudCode');
        const parsed = JSON.parse(res.body);
        assert.equal(parsed.status, 'ok');

        // Verify upstream received identical request
        assert.ok(upstreamReceived);
        assert.equal(upstreamReceived.url, '/v1internal:loadCodeAssist');
        assert.equal(upstreamReceived.headers['authorization'], 'Bearer test-oauth-token');
        assert.equal(upstreamReceived.body, testPayload);
    });

    await t.test('health endpoint reports proxy status', async () => {
        const res = await new Promise((resolve, reject) => {
            const req = http.get(`http://127.0.0.1:${proxyPort}/__proxy/health`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
            });
            req.on('error', reject);
        });

        assert.equal(res.statusCode, 200);
        const parsed = JSON.parse(res.body);
        assert.equal(parsed.status, 'ok');
        assert.equal(parsed.port, proxyPort);
    });
});
