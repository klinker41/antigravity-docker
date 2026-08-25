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
            const proxyCode = fs.readFileSync(path.join(__dirname, '../proxy/auth-proxy.js'), 'utf8');
            assert.ok(proxyCode.includes('Sidecar Manager'));
            assert.ok(proxyCode.includes('/sidecars'));
            assert.ok(proxyCode.includes('agy-injected-btn-sidecars'));
        });
    } finally {
        proxyProc.kill('SIGKILL');
    }
});
