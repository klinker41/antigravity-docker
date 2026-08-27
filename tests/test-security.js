const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const sidecarManager = require('../proxy/sidecar-manager.js');

test('Security - Path Traversal Protections (SEC-03)', async (t) => {
    await t.test('rejects path traversal in sidecar IDs', async () => {
        const maliciousIds = [
            '../../etc/passwd',
            '../sidecar',
            '/root/secret',
            'nested/../../dangerous',
            'sidecar/subdir/deep',
            'evil..id',
            'invalid*char',
            'space in id',
            ';rm -rf /;'
        ];

        for (const badId of maliciousIds) {
            assert.throws(() => {
                sidecarManager.sanitizeSidecarId(badId);
            }, /Invalid Sidecar ID/i, `Should throw for ID: ${badId}`);

            await assert.rejects(async () => {
                await sidecarManager.saveSidecar({
                    id: badId,
                    command: 'echo',
                    args: ['test']
                });
            }, `Should reject saveSidecar for ID: ${badId}`);
        }
    });

    await t.test('accepts valid alphanumeric, dashed, and underscored IDs', () => {
        const validIds = [
            'my-worker',
            'pr_triage_bot',
            'scheduled-123',
            'plugin-name/sidecar-name'
        ];

        for (const goodId of validIds) {
            const clean = sidecarManager.sanitizeSidecarId(goodId);
            assert.equal(clean, goodId);
        }
    });

    await t.test('resolveSecureSubpath prevents resolving outside base directory', () => {
        const baseDir = '/home/developer/.gemini/config/sidecars';
        const safe = sidecarManager.resolveSecureSubpath(baseDir, 'valid-id');
        assert.equal(safe, path.resolve(baseDir, 'valid-id'));

        assert.throws(() => {
            sidecarManager.resolveSecureSubpath(baseDir, '../outside');
        }, /Invalid Sidecar ID/i);
    });
});

test('Security - HTTP Proxy Gateway & Status Endpoint (SEC-06, SEC-07, SEC-10, SEC-14)', async (t) => {
    const TEST_PORT = 15566;
    const TEST_PASSWORD = 'sec-test-secret-password';

    const proxyProc = spawn(process.execPath, [path.join(__dirname, '../proxy/auth-proxy.js')], {
        env: {
            ...process.env,
            AGY_PORT: String(TEST_PORT),
            AUTH_PASSWORD: TEST_PASSWORD,
            RC_NAME: 'secret-instance-codename',
            INITIAL_TARGET_PORT: '49999',
            TRUST_PROXY: 'false'
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
                port: TEST_PORT,
                path: reqPath,
                method: options.method || 'GET',
                headers: options.headers || {}
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
            });
            req.on('error', reject);
            if (options.body) req.write(options.body);
            req.end();
        });
    }

    try {
        await t.test('applies Content-Security-Policy and standard security headers (SEC-14)', async () => {
            const res = await makeRequest('/status');
            assert.ok(res.headers['content-security-policy']);
            assert.ok(res.headers['content-security-policy'].includes("default-src 'self'"));
            assert.equal(res.headers['x-content-type-options'], 'nosniff');
            assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
        });

        await t.test('/status JSON format does not leak internal ports, instance name, or errors (SEC-10)', async () => {
            const res = await makeRequest('/status?format=json');
            const data = JSON.parse(res.body);

            assert.ok(data.status);
            assert.equal(data.instance, undefined, 'Must not leak instance name');
            assert.equal(data.targetPort, undefined, 'Must not leak target port');
            assert.equal(data.gatewayPort, undefined, 'Must not leak gateway port');
            assert.equal(data.services, undefined, 'Must not leak internal service list');
            assert.equal(data.error, undefined, 'Must not leak internal errors');
        });

        await t.test('/status HTML page does not leak internal ports or instance name (SEC-10)', async () => {
            const res = await makeRequest('/status');
            assert.equal(res.body.includes('secret-instance-codename'), false);
            assert.equal(res.body.includes('49999'), false);
            assert.equal(res.body.includes('15566'), false);
        });

        await t.test('does not trust spoofed X-Forwarded-For when TRUST_PROXY is false (SEC-06)', async () => {
            for (let i = 0; i < 5; i++) {
                await makeRequest('/__auth/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'X-Forwarded-For': `198.51.100.${i + 1}`
                    },
                    body: 'password=wrong-password'
                });
            }

            const lockedOut = await makeRequest('/__auth/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Forwarded-For': '198.51.100.99'
                },
                body: 'password=wrong-password'
            });

            assert.equal(lockedOut.status, 429);
            assert.ok(lockedOut.body.includes('Too many failed attempts'));
        });

        await t.test('Sidecar UI script contains escapeHtml utility (SEC-05)', () => {
            const proxyCode = fs.readFileSync(path.join(__dirname, '../proxy/auth-proxy.js'), 'utf8');
            assert.ok(proxyCode.includes('function escapeHtml(str)'));
            assert.ok(proxyCode.includes('escDisplayName'));
            assert.ok(proxyCode.includes('escDescription'));
        });
    } finally {
        proxyProc.kill('SIGKILL');
    }
});
