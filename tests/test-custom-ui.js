const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

test('Custom UI, Viewport & Foldable Layout', async (t) => {
    const TEST_PROXY_PORT = 16888;
    const TEST_TARGET_PORT = 16889;
    const TEST_PASSWORD = 'test-custom-ui-pass';

    // Mock upstream AGY server returning standard Antigravity HTML
    const mockAgyServer = http.createServer((req, res) => {
        if (req.url.startsWith('/?useWebSocket=true') || req.url === '/' || req.url === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html>
<html lang="en">
  <head>
    <script>window.__APP_CONFIG__ = {"productName":"antigravity-cli","csrfToken":"test-token"};</script>
    <meta charset="UTF-8" />
    <title>Antigravity CLI</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0" />
    <link rel="stylesheet" href="/jetbox.css" />
  </head>
  <body>
    <div id="root">
      <div role="navigation" aria-label="Sidebar" class="bg-sidebar">
        <div class="px-2">Sidebar Content</div>
        <div class="flex flex-col gap-1.5 px-2">
          <button data-testid="new-conversation-button">New Conversation</button>
          <button data-testid="customizations-button">Customizations</button>
        </div>
        <div class="flex flex-col gap-px pt-2 px-2">
          <button data-testid="settings-button">Settings</button>
        </div>
      </div>
      <div class="content-pane">Chat Content</div>
    </div>
  </body>
</html>`);
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('AGY Upstream OK');
    });

    await new Promise((resolve) => mockAgyServer.listen(TEST_TARGET_PORT, '127.0.0.1', resolve));

    // Spawn proxy instance with test ports
    const proxyProc = spawn(process.execPath, [path.join(__dirname, '../proxy/auth-proxy.js')], {
        env: {
            ...process.env,
            AGY_PORT: String(TEST_PROXY_PORT),
            AGY_HUB_PORT: String(TEST_TARGET_PORT),
            PORT_FILE: '/tmp/test_custom_ui_port_nonexistent',
            AUTH_PASSWORD: TEST_PASSWORD,
            INITIAL_TARGET_PORT: String(TEST_TARGET_PORT),
            ENABLE_IDE: 'false',
            ENABLE_TERMINAL: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    try {
        // Wait for proxy port to be ready
        let proxyReady = false;
        for (let i = 0; i < 30; i++) {
            try {
                const res = await fetch(`http://127.0.0.1:${TEST_PROXY_PORT}/status`);
                if (res.status === 200 || res.status === 503) {
                    proxyReady = true;
                    break;
                }
            } catch (err) {}
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(proxyReady, 'Proxy server failed to start within timeout');

        await t.test('GET /custom.css serves stylesheet unauthenticated', async () => {
            const res = await fetch(`http://127.0.0.1:${TEST_PROXY_PORT}/custom.css`);
            assert.equal(res.status, 200);
            assert.ok(res.headers.get('content-type')?.includes('text/css'));
            const css = await res.text();
            assert.ok(css.includes('--visual-viewport-height'), 'Should define --visual-viewport-height');
            assert.ok(css.includes('.agy-unfolded'), 'Should define .agy-unfolded rules');
            assert.ok(css.includes('--sidebar-width: 50%'), 'Should configure 50% split width');
            assert.ok(css.includes('sidebar-sash'), 'Should size split panes around sidebar-sash');
            assert.ok(css.includes('width: 50% !important'), 'Should enforce 50% split width on split panes');
            assert.ok(!css.includes('backdrop-filter'), 'Should not include backdrop-filter glass styling');
            assert.ok(!css.includes('border-radius: 18px'), 'Should not include rounded floating window corners');
            assert.ok(!css.includes('calc(100% - 16px)'), 'Should not inset sidebar height for floating window');
            assert.ok(css.includes('touch-action: pan-y'), 'Should enforce touch-action pan-y on sidebar for touch scrolling');
            assert.ok(css.includes('sidebar-search-button'), 'Should include styles for sidebar-search-button');
            assert.ok(css.includes('sidebar-toggle'), 'Should include styles for sidebar-toggle');
            assert.ok(css.includes('margin-left: auto'), 'Should right-align action buttons container');
        });

        await t.test('HTML proxying modifies viewport meta and injects custom css & pre-init script', async () => {
            // First authenticate to get session cookie
            const loginBody = new URLSearchParams({ password: TEST_PASSWORD }).toString();
            const loginRes = await fetch(`http://127.0.0.1:${TEST_PROXY_PORT}/__auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: loginBody,
                redirect: 'manual'
            });
            const cookie = loginRes.headers.get('set-cookie');
            assert.ok(cookie, 'Login should set session cookie');

            const res = await fetch(`http://127.0.0.1:${TEST_PROXY_PORT}/?useWebSocket=true`, {
                headers: { Cookie: cookie.split(';')[0] }
            });
            assert.equal(res.status, 200);
            const html = await res.text();

            // 1. Verify viewport meta tag has interactive-widget=resizes-content
            assert.ok(
                html.includes('interactive-widget=resizes-content'),
                'HTML should include interactive-widget=resizes-content in viewport meta'
            );

            // 2. Verify title and productName are transformed (Antigravity CLI -> Antigravity)
            assert.ok(
                html.includes('"productName":"antigravity"'),
                'HTML should replace productName with antigravity'
            );
            assert.ok(
                !html.includes('"productName":"antigravity-cli"'),
                'HTML should not contain antigravity-cli'
            );
            assert.ok(
                html.includes('<title>Antigravity</title>'),
                'HTML should contain <title>Antigravity</title>'
            );
            assert.ok(
                !html.includes('<title>Antigravity CLI</title>'),
                'HTML should not contain <title>Antigravity CLI</title>'
            );

            // 3. Verify custom.css link and inlined style are injected in <head>
            assert.ok(
                html.includes('<style id="agy-custom-css">'),
                'HTML head should inline agy-custom-css'
            );
            assert.ok(
                html.includes('<link rel="stylesheet" href="/custom.css" />'),
                'HTML head should link /custom.css'
            );

            // 4. Verify pre-init script is injected in <head>
            assert.ok(
                html.includes('<script id="agy-pre-init">'),
                'HTML head should include agy-pre-init script'
            );
            assert.ok(
                html.includes('isFoldableUnfolded'),
                'Pre-init script should include isFoldableUnfolded detection'
            );
            assert.ok(
                html.includes('--visual-viewport-height'),
                'Pre-init script should manage --visual-viewport-height'
            );
            assert.ok(
                html.includes('focusin'),
                'Pre-init script should listen to focusin for smooth input scrolling'
            );
            assert.ok(
                html.includes('autocapitalize') && html.includes('sentences'),
                'Pre-init script should enforce autocapitalize="sentences" on message box'
            );
            assert.ok(
                html.includes('sanitizeDocumentTitle'),
                'Pre-init script should sanitize document title'
            );
            assert.ok(
                html.includes('syncSidebarWidth'),
                'Pre-init script should sync sidebar width'
            );
            assert.ok(
                html.includes('shouldDisableSidebarDnd'),
                'Pre-init script should intercept DnD on touch and unfolded views'
            );

            // 5. Verify injected workspace tools script is in <body>
            assert.ok(
                html.includes('id="agy-injected-tools-script"'),
                'HTML body should include injected tools script'
            );
            assert.ok(
                html.includes('Customizations'),
                'Injected script should target Customizations section in sidebar'
            );
            assert.ok(
                html.includes('settings-button'),
                'Injected script should include settings-button fallback'
            );
        });
    } finally {
        proxyProc.kill('SIGTERM');
        await new Promise((resolve) => mockAgyServer.close(resolve));
    }
});
