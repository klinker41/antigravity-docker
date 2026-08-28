const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const sidecarManager = require('../proxy/sidecar-manager.js');

test('Sidecar Manager - Cron Parser & Matching', async (t) => {
    await t.test('parses minute wildcards and intervals', () => {
        const everyMinute = sidecarManager.matchesCron('* * * * *', new Date('2026-08-25T14:35:00Z'));
        assert.equal(everyMinute, true);

        const every15min = sidecarManager.matchesCron('*/15 * * * *', new Date('2026-08-25T14:30:00Z'));
        assert.equal(every15min, true);

        const every15minFalse = sidecarManager.matchesCron('*/15 * * * *', new Date('2026-08-25T14:37:00Z'));
        assert.equal(every15minFalse, false);
    });

    await t.test('parses specific hour, minute, and range fields', () => {
        const date9am = new Date(2026, 7, 25, 9, 0, 0); // 9:00 AM local
        const match9am = sidecarManager.matchesCron('0 9 * * *', date9am);
        assert.equal(match9am, true);

        const date10am = new Date(2026, 7, 25, 10, 0, 0);
        const match10am = sidecarManager.matchesCron('0 9 * * *', date10am);
        assert.equal(match10am, false);

        // Weekday range (1-5)
        const tuesday = new Date(2026, 7, 25, 12, 0, 0); // Tue (day 2)
        assert.equal(sidecarManager.matchesCron('0 12 * * 1-5', tuesday), true);
    });

    await t.test('describes cron expressions in human terms', () => {
        assert.equal(sidecarManager.describeCron('* * * * *'), 'Every minute');
        assert.equal(sidecarManager.describeCron('*/10 * * * *'), 'Every 10 minutes');
        assert.equal(sidecarManager.describeCron('0 * * * *'), 'Every hour, on the hour');
        assert.equal(sidecarManager.describeCron('0 9 * * *'), 'Daily at 09:00');
    });

    await t.test('calculates next cron run time', () => {
        const next = sidecarManager.getNextCronRun('0 * * * *', new Date(2026, 7, 25, 14, 25, 0));
        assert.ok(next);
        const nextDate = new Date(next);
        assert.equal(nextDate.getMinutes(), 0);
    });
});

test('Sidecar Manager - CRUD & Persistence', async (t) => {
    const testId = 'test-worker-bot';

    await t.test('creates and saves a continuous worker sidecar', async () => {
        const saved = await sidecarManager.saveSidecar({
            id: testId,
            displayName: 'Test Worker Bot',
            description: 'A test background worker',
            command: 'echo',
            args: ['Hello from worker!'],
            restartPolicy: 'never',
            enabled: true,
            projectId: 'outside-of-project'
        });

        assert.equal(saved.id, testId);
        assert.equal(saved.displayName, 'Test Worker Bot');
        assert.equal(saved.enabled, true);
        assert.equal(saved.command, 'echo');
        assert.equal(saved.restartPolicy, 'never');

        const found = sidecarManager.getSidecar(testId);
        assert.ok(found);
        assert.equal(found.id, testId);
    });

    await t.test('creates and saves a scheduled agent prompt sidecar', async () => {
        const schedId = 'test-sched-prompt';
        const saved = await sidecarManager.saveSidecar({
            id: schedId,
            displayName: 'Scheduled PR Triage',
            description: 'Triages PRs every hour',
            builtin: 'schedule',
            args: ['0 * * * *', 'agentapi', 'new-conversation', 'Summarize pending PRs'],
            enabled: true,
            projectId: 'outside-of-project'
        });

        assert.equal(saved.id, schedId);
        assert.equal(saved.isScheduled, true);
        assert.equal(saved.cronExpr, '0 * * * *');
        assert.equal(saved.enabled, true);

        // Verify config.json
        const config = sidecarManager.readConfig();
        assert.ok(config.sidecars);
        assert.ok(config.sidecars[schedId]);
        assert.equal(config.sidecars[schedId].enabled, true);
        assert.equal(config.sidecars[schedId].projectId, 'outside-of-project');

        // Cleanup
        await sidecarManager.deleteSidecar(schedId);
        assert.equal(sidecarManager.getSidecar(schedId), null);
    });

    await t.test('toggles sidecar enabled state', async () => {
        const toggledOff = await sidecarManager.toggleSidecar(testId, false);
        assert.equal(toggledOff.enabled, false);

        const config = sidecarManager.readConfig();
        assert.equal(config.sidecars[testId].enabled, false);

        const toggledOn = await sidecarManager.toggleSidecar(testId, true);
        assert.equal(toggledOn.enabled, true);
    });

    await t.test('triggers immediate sidecar execution and checks logs', async () => {
        const res = await sidecarManager.triggerSidecar(testId);
        assert.ok(res);
        assert.ok(res.message);

        // Wait brief tick for process
        await new Promise(r => setTimeout(r, 200));

        const logs = sidecarManager.getLogs(testId);
        assert.ok(typeof logs === 'string');
    });

    await t.test('resolves and injects ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN into sidecar environment', async () => {
        sidecarManager.setLsAddress('127.0.0.1:45678');
        sidecarManager.setCsrfToken('test-csrf-token-12345');
        assert.equal(sidecarManager.getLsAddress(), '127.0.0.1:45678');
        assert.equal(await sidecarManager.getCsrfToken(), 'test-csrf-token-12345');

        const envTestId = 'test-env-bot';
        await sidecarManager.saveSidecar({
            id: envTestId,
            displayName: 'Env Test Bot',
            command: process.execPath,
            args: ['-e', 'console.log("LS_ADDR=" + (process.env.ANTIGRAVITY_LS_ADDRESS || "NONE") + ",CSRF=" + (process.env.ANTIGRAVITY_CSRF_TOKEN || "NONE"))'],
            restartPolicy: 'never',
            enabled: true
        });

        await new Promise(r => setTimeout(r, 400));
        const logs = sidecarManager.getLogs(envTestId);
        assert.ok(logs.includes('LS_ADDR=127.0.0.1:45678'));
        assert.ok(logs.includes('CSRF=test-csrf-token-12345'));

        await sidecarManager.deleteSidecar(envTestId);
    });

    await t.test('fetches CSRF token from language server root HTML endpoint', async () => {
        // Spin up mock server returning HTML with CSRF token
        const mockServer = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<!doctype html><html><head><script>window.__APP_CONFIG__ = {"productName":"antigravity-cli","csrfToken":"mock-server-csrf-abc","appVersion":"","devMode":false};</script></head><body></body></html>');
        });

        await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
        const mockPort = mockServer.address().port;

        sidecarManager.csrfToken = null;
        delete process.env.ANTIGRAVITY_CSRF_TOKEN;
        try { fs.unlinkSync('/tmp/antigravity_csrf_token'); } catch (e) {}

        const fetched = await sidecarManager.fetchCsrfFromAddress(`127.0.0.1:${mockPort}`);
        assert.equal(fetched, 'mock-server-csrf-abc');

        mockServer.close();
    });

    await t.test('lists registered projects', () => {
        const projects = sidecarManager.listProjects();
        assert.ok(Array.isArray(projects));
        assert.ok(projects.length > 0);
        assert.ok(projects.some(p => p.id === 'outside-of-project'));
    });

    await t.test('deletes sidecar and cleans up config', async () => {
        await sidecarManager.deleteSidecar(testId);
        const found = sidecarManager.getSidecar(testId);
        assert.equal(found, null);

        const config = sidecarManager.readConfig();
        assert.equal(config.sidecars[testId], undefined);
    });
});

test('Sidecar Manager - HTTP Proxy Integration', async (t) => {
    // Spin up an instance of auth-proxy server on a test port
    const TEST_PORT = 14455;
    process.env.AGY_PORT = String(TEST_PORT);
    process.env.AUTH_PASSWORD = 'test-secret-password';

    // Spawn proxy process
    const { spawn } = require('node:child_process');
    const proxyProc = spawn(process.execPath, [path.join(__dirname, '../proxy/auth-proxy.js')], {
        env: {
            ...process.env,
            AGY_PORT: String(TEST_PORT),
            AUTH_PASSWORD: 'test-secret-password'
        },
        stdio: 'pipe'
    });

    await new Promise((resolve) => {
        proxyProc.stdout.on('data', (d) => {
            if (d.toString().includes('Listening on')) resolve();
        });
        setTimeout(resolve, 1500);
    });

    function makeRequest(path, options = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: TEST_PORT,
                path,
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
        await t.test('requires authentication for /sidecars route', async () => {
            const res = await makeRequest('/sidecars');
            assert.equal(res.status, 200);
            assert.ok(res.body.includes('Google Antigravity Remote Access')); // Returns login page
        });

        await t.test('requires authentication for /api/sidecars REST API', async () => {
            const res = await makeRequest('/api/sidecars');
            assert.equal(res.status, 401);
            const json = JSON.parse(res.body);
            assert.ok(json.error);
        });

        await t.test('logs in and accesses /sidecars and REST APIs', async () => {
            // Post login form
            const loginRes = await makeRequest('/__auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'password=test-secret-password'
            });
            assert.equal(loginRes.status, 302);
            const cookie = loginRes.headers['set-cookie']?.[0]?.split(';')[0];
            assert.ok(cookie);

            // Access /sidecars with cookie
            const sidecarsPage = await makeRequest('/sidecars', {
                headers: { Cookie: cookie }
            });
            assert.equal(sidecarsPage.status, 200);
            assert.ok(sidecarsPage.body.includes('Sidecar Manager'));
            assert.ok(sidecarsPage.body.includes('Define New Sidecar'));

            // Access /api/projects
            const projectsRes = await makeRequest('/api/projects', {
                headers: { Cookie: cookie }
            });
            assert.equal(projectsRes.status, 200);
            const projects = JSON.parse(projectsRes.body);
            assert.ok(Array.isArray(projects));

            // Create sidecar via API
            const createRes = await makeRequest('/api/sidecars', {
                method: 'POST',
                headers: { Cookie: cookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: 'api-test-sidecar',
                    displayName: 'API Test Bot',
                    description: 'Testing API endpoints',
                    command: 'echo',
                    args: ['running via api'],
                    restartPolicy: 'never',
                    enabled: true
                })
            });
            assert.equal(createRes.status, 200);
            const created = JSON.parse(createRes.body);
            assert.equal(created.id, 'api-test-sidecar');

            // Toggle sidecar via API
            const toggleRes = await makeRequest('/api/sidecars/api-test-sidecar/toggle', {
                method: 'POST',
                headers: { Cookie: cookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: false })
            });
            assert.equal(toggleRes.status, 200);
            const toggled = JSON.parse(toggleRes.body);
            assert.equal(toggled.enabled, false);

            // Delete sidecar via API
            const delRes = await makeRequest('/api/sidecars/api-test-sidecar', {
                method: 'DELETE',
                headers: { Cookie: cookie }
            });
            assert.equal(delRes.status, 200);
        });

        await t.test('verifies workspace tools sidebar injection contains Sidecar Manager', async () => {
            const authRes = await makeRequest('/__auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'password=test-secret-password'
            });
            const cookie = authRes.headers['set-cookie']?.[0]?.split(';')[0];

            // When proxy receives an upstream HTML response (simulated or rendered)
            // Verify buildInjectedScript includes Sidecar Manager
            const injectionCode = fs.readFileSync(path.join(__dirname, '../proxy/lib/ui-injection.js'), 'utf8');
            assert.ok(injectionCode.includes('Sidecar Manager'));
            assert.ok(injectionCode.includes('/sidecars'));
            assert.ok(injectionCode.includes('agy-injected-btn-sidecars'));

            const { INJECTED_UI_STYLES } = require('../proxy/lib/ui-injection');
            assert.ok(INJECTED_UI_STYLES.includes('@media (max-width: 768px)'));
            assert.ok(INJECTED_UI_STYLES.includes('.agy-injected-tools-group'));
            assert.ok(INJECTED_UI_STYLES.includes('display: none !important;'));
        });
    } finally {
        proxyProc.kill('SIGKILL');
    }
});

test('Sidecar Manager - Plugin Sidecars & Adjacent Binaries', async (t) => {
    const HOME_DIR = process.env.HOME || '/home/developer';
    const GEMINI_CONFIG_DIR = process.env.GEMINI_CONFIG_DIR || path.join(HOME_DIR, '.gemini/config');
    const PLUGINS_DIR = path.join(GEMINI_CONFIG_DIR, 'plugins');

    const testPluginDir = path.join(PLUGINS_DIR, 'test-plugin-runner');
    const testSidecarDir = path.join(testPluginDir, 'sidecars', 'runner-bot');
    const extPluginDir = '/tmp/test-external-plugin';
    const extSidecarDir = path.join(extPluginDir, 'sidecars', 'ext-bot');
    const pluginsJsonPath = path.join(GEMINI_CONFIG_DIR, 'plugins.json');

    // Setup test plugin 1 in ~/.gemini/config/plugins/
    fs.mkdirSync(testSidecarDir, { recursive: true });
    fs.writeFileSync(path.join(testPluginDir, 'plugin.json'), JSON.stringify({ name: 'test-plugin-runner' }, null, 2), 'utf8');

    // Create an adjacent binary executable
    const binaryPath = path.join(testSidecarDir, 'custom_binary');
    fs.writeFileSync(binaryPath, '#!/bin/sh\necho "CWD_PATH=$(pwd)"\necho "ARG1=$1"\n', { encoding: 'utf8', mode: 0o755 });

    fs.writeFileSync(path.join(testSidecarDir, 'sidecar.json'), JSON.stringify({
        display_name: 'Plugin Runner Bot',
        description: 'Test sidecar inside plugin with adjacent binary',
        command: 'custom_binary',
        args: ['hello-adjacent-binary'],
        restart_policy: 'never',
        enabled: false
    }, null, 2), 'utf8');

    // Setup test plugin 2 registered via plugins.json
    fs.mkdirSync(extSidecarDir, { recursive: true });
    fs.writeFileSync(path.join(extPluginDir, 'plugin.json'), JSON.stringify({ name: 'test-ext-plugin' }, null, 2), 'utf8');
    const extBinaryPath = path.join(extSidecarDir, 'ext_binary');
    fs.writeFileSync(extBinaryPath, '#!/bin/sh\necho "EXT_CWD=$(pwd)"\necho "EXT_ARG=$1"\n', { encoding: 'utf8', mode: 0o755 });

    fs.writeFileSync(path.join(extSidecarDir, 'sidecar.json'), JSON.stringify({
        display_name: 'External Plugin Bot',
        command: './ext_binary',
        args: ['external-arg'],
        restart_policy: 'never',
        enabled: false
    }, null, 2), 'utf8');

    let originalPluginsJson = null;
    if (fs.existsSync(pluginsJsonPath)) {
        originalPluginsJson = fs.readFileSync(pluginsJsonPath, 'utf8');
    }

    try {
        // Register external plugin in plugins.json
        fs.writeFileSync(pluginsJsonPath, JSON.stringify({
            entries: [{ path: extPluginDir }]
        }, null, 2), 'utf8');

        await t.test('discovers sidecars from ~/.gemini/config/plugins and plugins.json', () => {
            const sidecars = sidecarManager.listSidecars();
            const pluginSidecar = sidecars.find(s => s.id === 'test-plugin-runner/runner-bot');
            assert.ok(pluginSidecar, 'Should discover plugin sidecar from plugins folder');
            assert.equal(pluginSidecar.isPlugin, true);
            assert.equal(pluginSidecar.pluginName, 'test-plugin-runner');
            assert.equal(pluginSidecar.displayName, 'Plugin Runner Bot');
            assert.equal(pluginSidecar.directory, testSidecarDir);

            const extSidecar = sidecars.find(s => s.id === 'test-ext-plugin/ext-bot');
            assert.ok(extSidecar, 'Should discover external plugin sidecar via plugins.json');
            assert.equal(extSidecar.isPlugin, true);
            assert.equal(extSidecar.pluginName, 'test-ext-plugin');
            assert.equal(extSidecar.directory, extSidecarDir);
        });

        await t.test('executes adjacent binary found via PATH with sidecar dir as cwd', async () => {
            const sidecarId = 'test-plugin-runner/runner-bot';
            await sidecarManager.toggleSidecar(sidecarId, true);

            const sidecar = sidecarManager.getSidecar(sidecarId);
            assert.equal(sidecar.enabled, true);

            await sidecarManager.triggerSidecar(sidecarId);
            await new Promise(r => setTimeout(r, 400));

            const logs = sidecarManager.getLogs(sidecarId);
            assert.ok(logs.includes(`CWD_PATH=${testSidecarDir}`), `Logs should show cwd as sidecar directory: ${logs}`);
            assert.ok(logs.includes('ARG1=hello-adjacent-binary'), `Logs should capture arguments passed: ${logs}`);

            await sidecarManager.toggleSidecar(sidecarId, false);
        });

        await t.test('executes relative binary ./ext_binary with sidecar dir as cwd', async () => {
            const extId = 'test-ext-plugin/ext-bot';
            await sidecarManager.toggleSidecar(extId, true);

            await sidecarManager.triggerSidecar(extId);
            await new Promise(r => setTimeout(r, 400));

            const logs = sidecarManager.getLogs(extId);
            assert.ok(logs.includes(`EXT_CWD=${extSidecarDir}`), `Logs should show cwd as external sidecar directory: ${logs}`);
            assert.ok(logs.includes('EXT_ARG=external-arg'), `Logs should capture external argument: ${logs}`);

            await sidecarManager.toggleSidecar(extId, false);
        });

        await t.test('deleting a plugin sidecar removes config override without deleting plugin source files', async () => {
            const sidecarId = 'test-plugin-runner/runner-bot';
            await sidecarManager.saveSidecar({
                id: sidecarId,
                enabled: true,
                projectId: 'test-project-123'
            });

            let config = sidecarManager.readConfig();
            assert.ok(config.sidecars[sidecarId]);

            await sidecarManager.deleteSidecar(sidecarId);

            config = sidecarManager.readConfig();
            assert.equal(config.sidecars[sidecarId], undefined, 'Config override should be removed');

            // Plugin directory and files must still exist!
            assert.ok(fs.existsSync(testSidecarDir), 'Plugin sidecar folder must remain on disk');
            assert.ok(fs.existsSync(binaryPath), 'Plugin binary must remain on disk');
            assert.ok(fs.existsSync(path.join(testSidecarDir, 'sidecar.json')), 'Plugin sidecar.json must remain on disk');
        });
    } finally {
        // Clean up test directories
        try { fs.rmSync(testPluginDir, { recursive: true, force: true }); } catch (e) {}
        try { fs.rmSync(extPluginDir, { recursive: true, force: true }); } catch (e) {}
        if (originalPluginsJson) {
            fs.writeFileSync(pluginsJsonPath, originalPluginsJson, 'utf8');
        } else {
            try { fs.unlinkSync(pluginsJsonPath); } catch (e) {}
        }
    }
});

