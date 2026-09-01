const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');

test('Hub Port Configuration & --hub-port Flag Integration', async (t) => {
    const rootDir = path.resolve(__dirname, '..');
    const entrypointPath = path.join(rootDir, 'entrypoint.sh');
    const entrypointContent = fs.readFileSync(entrypointPath, 'utf8');

    await t.test('entrypoint.sh sets AGY_HUB_PORT default to 4402', () => {
        assert.match(entrypointContent, /AGY_HUB_PORT="\$\{AGY_HUB_PORT:-4402\}"/);
    });

    await t.test('entrypoint.sh passes --hub-port in setup and daemon modes', () => {
        // Match setup mode agy execution
        const setupMatch = entrypointContent.match(/setup\)[\s\S]*?exec gosu "\$DEVELOPER_USER" agy --remote-control[^\n]*--hub-port "\$AGY_HUB_PORT"/);
        assert.ok(setupMatch, 'entrypoint.sh setup mode must pass --hub-port "$AGY_HUB_PORT"');

        // Match daemon mode agy execution
        const daemonMatch = entrypointContent.match(/daemon\)[\s\S]*?exec gosu "\$DEVELOPER_USER" agy --remote-control[^\n]*--hub-port "\$AGY_HUB_PORT"/);
        assert.ok(daemonMatch, 'entrypoint.sh daemon mode must pass --hub-port "$AGY_HUB_PORT"');
    });

    await t.test('entrypoint.sh writes AGY_HUB_PORT directly to port and address files', () => {
        assert.match(entrypointContent, /echo "\$AGY_HUB_PORT" > \/tmp\/antigravity_port/);
        assert.match(entrypointContent, /echo "127\.0\.0\.1:\$AGY_HUB_PORT" > \/tmp\/antigravity_ls_address/);
    });

    await t.test('entrypoint.sh does not use regex stdout scraping loop for port discovery', () => {
        assert.doesNotMatch(entrypointContent, /BASH_REMATCH\[2\]/);
        assert.doesNotMatch(entrypointContent, /while IFS= read -r line/);
    });

    await t.test('proxy/lib/config.js exports AGY_HUB_PORT with default 4402', () => {
        const config = require('../proxy/lib/config');
        assert.equal(typeof config.AGY_HUB_PORT, 'number');
        assert.equal(config.AGY_HUB_PORT, 4402);
    });

    await t.test('proxy/sidecar-manager.js resolves LS address using AGY_HUB_PORT', () => {
        const sidecarManager = require('../proxy/sidecar-manager');
        const originalHubPort = process.env.AGY_HUB_PORT;
        const originalLsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
        const originalInstanceLs = sidecarManager.lsAddress;
        delete process.env.ANTIGRAVITY_LS_ADDRESS;
        sidecarManager.lsAddress = null;

        try {
            process.env.AGY_HUB_PORT = '4455';
            const addr = sidecarManager.getLsAddress();
            assert.equal(addr, '127.0.0.1:4455');
        } finally {
            sidecarManager.lsAddress = originalInstanceLs;
            if (originalHubPort !== undefined) {
                process.env.AGY_HUB_PORT = originalHubPort;
            } else {
                delete process.env.AGY_HUB_PORT;
            }
            if (originalLsAddr !== undefined) {
                process.env.ANTIGRAVITY_LS_ADDRESS = originalLsAddr;
            }
        }
    });

    await t.test('auth-proxy bridges to custom AGY_HUB_PORT upstream', async () => {
        const TEST_PROXY_PORT = 19920;
        const TEST_HUB_PORT = 19921;

        // Mock upstream hub server
        const mockUpstream = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('Upstream AGY Response on Port 19921');
        });

        await new Promise((resolve) => mockUpstream.listen(TEST_HUB_PORT, '127.0.0.1', resolve));

        const proxyProc = spawn(process.execPath, [path.join(__dirname, '../proxy/auth-proxy.js')], {
            env: {
                ...process.env,
                AGY_PORT: String(TEST_PROXY_PORT),
                AGY_HUB_PORT: String(TEST_HUB_PORT),
                AUTH_PASSWORD: '',
                PORT_FILE: '/tmp/test_hub_port_nonexistent',
                ENABLE_IDE: 'false',
                ENABLE_TERMINAL: 'false'
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        await new Promise((resolve) => {
            proxyProc.stdout.on('data', (d) => {
                if (d.toString().includes('Listening on')) resolve();
            });
            setTimeout(resolve, 1500);
        });

        try {
            const statusRes = await new Promise((resolve, reject) => {
                const req = http.get(`http://127.0.0.1:${TEST_PROXY_PORT}/status`, (res) => {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => resolve({ status: res.statusCode, body }));
                });
                req.on('error', reject);
            });

            assert.equal(statusRes.status, 200);

            const upstreamRes = await new Promise((resolve, reject) => {
                const req = http.get(`http://127.0.0.1:${TEST_PROXY_PORT}/api/test`, (res) => {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => resolve({ status: res.statusCode, body }));
                });
                req.on('error', reject);
            });

            assert.equal(upstreamRes.status, 200);
            assert.equal(upstreamRes.body, 'Upstream AGY Response on Port 19921');
        } finally {
            proxyProc.kill('SIGKILL');
            mockUpstream.close();
        }
    });
});
