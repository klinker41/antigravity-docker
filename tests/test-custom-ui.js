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
            assert.ok(css.includes('--sidebar-width: 50vw'), 'Should configure 50vw split width');
            assert.ok(css.includes('sidebar-sash'), 'Should size split panes around sidebar-sash');
            assert.ok(css.includes('width: 50% !important'), 'Should enforce 50% split width on split panes');
            assert.ok(css.includes('width: 100% !important'), 'Should stretch inner wrapper to 100% width');
            assert.ok(css.includes('width: 50vw !important'), 'Should size unfolded header container to 50vw');
            assert.ok(!css.includes('backdrop-filter'), 'Should not include backdrop-filter glass styling');
            assert.ok(!css.includes('border-radius: 18px'), 'Should not include rounded floating window corners');
            assert.ok(!css.includes('calc(100% - 16px)'), 'Should not inset sidebar height for floating window');
            assert.ok(css.includes('--safe-area-bottom'), 'Should define --safe-area-bottom');
            assert.ok(css.includes('env(safe-area-inset-bottom'), 'Should use env(safe-area-inset-bottom)');
            assert.ok(css.includes('agent-input-box'), 'Should pad agent-input-box above nav bar');
            assert.ok(css.includes('touch-action: pan-y'), 'Should enforce touch-action pan-y on sidebar for touch scrolling');
            assert.ok(css.includes('[data-project-card]'), 'Should target [data-project-card] for touch scrolling');
            assert.ok(css.includes('[data-testid="project-header"]'), 'Should target [data-testid="project-header"] for touch scrolling');
            assert.ok(css.includes('-webkit-user-drag: none'), 'Should disable -webkit-user-drag on sidebar items');
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
                html.includes('autocorrect') && html.includes('spellcheck') && html.includes('autocomplete'),
                'Pre-init script should enforce autocorrect="on", spellcheck="true", and autocomplete="on" on message box'
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
            assert.ok(
                html.includes('updateDynamicBottomPadding'),
                'Pre-init script should calculate dynamic bottom nav bar padding'
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
            assert.ok(
                html.includes('hover:bg-sidebar-muted'),
                'Injected script buttons should match native hover:bg-sidebar-muted class'
            );
            assert.ok(
                html.includes('text-secondary-foreground'),
                'Injected script buttons should match native text-secondary-foreground class'
            );
            assert.ok(
                html.includes('shrink-0 flex items-center'),
                'Injected script buttons should wrap icon in native shrink-0 flex items-center container'
            );
            assert.ok(
                !html.includes('agy-injected-external-icon'),
                'Injected script buttons should not include external link icon'
            );
        });

        await t.test('Pre-init script enforces autocorrect, spellcheck, autocomplete, and autocapitalize on prompt inputs', () => {
            const vm = require('node:vm');
            const { buildPreInitScript } = require('../proxy/lib/ui-injection');

            class FakeHTMLElement {
                constructor(tagName = 'DIV') {
                    this.tagName = tagName;
                    this._attrs = {};
                    this.contentEditable = 'inherit';
                    this.spellcheck = true;
                }
                getAttribute(name) {
                    return Object.prototype.hasOwnProperty.call(this._attrs, name.toLowerCase())
                        ? this._attrs[name.toLowerCase()]
                        : null;
                }
                setAttribute(name, value) {
                    this._attrs[name.toLowerCase()] = String(value);
                }
                removeAttribute(name) {
                    delete this._attrs[name.toLowerCase()];
                }
                closest() {
                    return null;
                }
            }

            const sandbox = {
                window: {
                    innerWidth: 400,
                    innerHeight: 800,
                    addEventListener: () => {},
                    localStorage: { getItem: () => null, removeItem: () => {} },
                },
                navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14)', maxTouchPoints: 5 },
                document: {
                    readyState: 'loading',
                    title: 'Antigravity CLI',
                    documentElement: {
                        style: { setProperty: () => {}, removeProperty: () => {} },
                        classList: { toggle: () => {}, contains: () => false },
                        appendChild: () => {},
                    },
                    addEventListener: () => {},
                    getElementById: () => null,
                    querySelector: () => null,
                    querySelectorAll: () => [],
                    createElement: () => ({
                        style: {},
                        getBoundingClientRect: () => ({ height: 0 }),
                        remove: () => {},
                    }),
                },
                HTMLElement: FakeHTMLElement,
                Document: function() {},
                HTMLDocument: function() {},
                Object,
                String,
                Number,
                Math,
                setTimeout,
            };

            vm.runInNewContext(buildPreInitScript(), sandbox);

            // Simulate Antigravity's Lexical Z$a component mounting a prompt box
            const promptEl = new FakeHTMLElement('DIV');
            promptEl.setAttribute('aria-label', 'Message input');
            promptEl.setAttribute('role', 'combobox');
            promptEl.setAttribute('autocapitalize', 'off');
            promptEl.setAttribute('autocorrect', 'off');
            promptEl.setAttribute('spellcheck', 'false');
            promptEl.setAttribute('autocomplete', 'off');
            promptEl.contentEditable = 'true';

            assert.equal(promptEl.getAttribute('autocapitalize'), 'sentences');
            assert.equal(promptEl.getAttribute('autocorrect'), 'on');
            assert.equal(promptEl.getAttribute('spellcheck'), 'true');
            assert.equal(promptEl.getAttribute('autocomplete'), 'on');

            // Simulate Lexical focus() trying to remove attributes
            promptEl.removeAttribute('autocapitalize');
            promptEl.removeAttribute('autocorrect');
            promptEl.removeAttribute('spellcheck');
            promptEl.removeAttribute('autocomplete');

            assert.equal(promptEl.getAttribute('autocapitalize'), 'sentences');
            assert.equal(promptEl.getAttribute('autocorrect'), 'on');
            assert.equal(promptEl.getAttribute('spellcheck'), 'true');
            assert.equal(promptEl.getAttribute('autocomplete'), 'on');

            // Ensure inline <code> elements keep spellcheck="false" untouched
            const codeEl = new FakeHTMLElement('CODE');
            codeEl.setAttribute('spellcheck', 'false');
            assert.equal(codeEl.getAttribute('spellcheck'), 'false');
        });

        await t.test('Pre-init script stops pointerdown and dragstart on sidebar project headers and conversation rows on touch/unfolded', () => {
            const vm = require('node:vm');
            const { buildPreInitScript } = require('../proxy/lib/ui-injection');

            const docListeners = {};
            class FakeHTMLElement {}

            let isUnfoldedViewport = true;
            let isCoarsePointer = true;

            const sandbox = {
                window: {
                    get innerWidth() { return isUnfoldedViewport ? 800 : 1440; },
                    get innerHeight() { return isUnfoldedViewport ? 850 : 900; },
                    matchMedia: (q) => ({ matches: q === '(pointer: coarse)' ? isCoarsePointer : false }),
                    addEventListener: () => {},
                    localStorage: { getItem: () => null, removeItem: () => {} },
                },
                navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14)', maxTouchPoints: 5 },
                document: {
                    readyState: 'loading',
                    title: 'Antigravity',
                    documentElement: {
                        style: { setProperty: () => {}, removeProperty: () => {} },
                        classList: {
                            toggle: () => {},
                            contains: (cls) => cls === 'agy-unfolded' && isUnfoldedViewport,
                        },
                        appendChild: () => {},
                    },
                    addEventListener: (type, fn, capture) => {
                        if (!docListeners[type]) docListeners[type] = [];
                        docListeners[type].push({ fn, capture });
                    },
                    getElementById: () => null,
                    querySelector: () => null,
                    querySelectorAll: () => [],
                    createElement: () => ({
                        style: {},
                        getBoundingClientRect: () => ({ height: 0 }),
                        remove: () => {},
                    }),
                },
                HTMLElement: FakeHTMLElement,
                Document: function() {},
                HTMLDocument: function() {},
                Object,
                String,
                Number,
                Math,
                setTimeout,
            };

            vm.runInNewContext(buildPreInitScript(), sandbox);

            const sidebar = {};
            const scrollContainer = {};
            sidebar.contains = (el) => el === scrollContainer;

            function makeTarget(matchedInteractiveSelector = null) {
                return {
                    closest: (sel) => {
                        if (sel.includes('aria-label="Sidebar"')) return sidebar;
                        if (sel.includes('.overflow-y-auto') || sel.includes('[data-sidebar-scroll-container]')) return scrollContainer;
                        if (matchedInteractiveSelector && sel.includes(matchedInteractiveSelector)) return {};
                        return null;
                    }
                };
            }

            function fireDocEvent(type, eventObj) {
                for (const l of docListeners[type] || []) {
                    l.fn(eventObj);
                }
            }

            // 1. Touch / unfolded pointerdown on a project header (<button data-testid="project-header"> wrapped in mE aria-haspopup="menu") MUST be stopped
            let stoppedProject = false;
            let immediateStoppedProject = false;
            fireDocEvent('pointerdown', {
                pointerType: 'touch',
                target: makeTarget('[aria-haspopup]'),
                stopPropagation: () => { stoppedProject = true; },
                stopImmediatePropagation: () => { immediateStoppedProject = true; },
            });
            assert.equal(stoppedProject, true, 'Should stop pointerdown on project header even when wrapped in aria-haspopup context menu trigger');
            assert.equal(immediateStoppedProject, true, 'Should stopImmediatePropagation on project header pointerdown');

            // 1b. Subsequent pointermove during sidebar touch scroll MUST also be stopped so window pointermove listeners cannot trigger drag
            let stoppedMove = false;
            let immediateStoppedMove = false;
            fireDocEvent('pointermove', {
                pointerType: 'touch',
                target: makeTarget('[aria-haspopup]'),
                stopPropagation: () => { stoppedMove = true; },
                stopImmediatePropagation: () => { immediateStoppedMove = true; },
            });
            assert.equal(stoppedMove, true, 'Should stop pointermove during active sidebar touch scroll');
            assert.equal(immediateStoppedMove, true, 'Should stopImmediatePropagation on pointermove during active sidebar touch scroll');

            // 2. Touch pointerdown on a [data-no-drag] menu button (e.g. Project options 3-dots menu) should NOT be stopped
            let stoppedMenu = false;
            fireDocEvent('pointerdown', {
                pointerType: 'touch',
                target: makeTarget('[data-no-drag]'),
                stopPropagation: () => { stoppedMenu = true; },
            });
            assert.equal(stoppedMenu, false, 'Should allow pointerdown on [data-no-drag] menu triggers');

            // 3. Touch pointerdown on an inline rename <input> should NOT be stopped
            let stoppedInput = false;
            fireDocEvent('pointerdown', {
                pointerType: 'touch',
                target: makeTarget('input'),
                stopPropagation: () => { stoppedInput = true; },
            });
            assert.equal(stoppedInput, false, 'Should allow pointerdown on input elements');

            // 4. Desktop mouse pointerdown (not unfolded, pointer not coarse) should NOT be stopped
            isUnfoldedViewport = false;
            isCoarsePointer = false;
            let stoppedDesktopMouse = false;
            fireDocEvent('pointerdown', {
                pointerType: 'mouse',
                target: makeTarget(null),
                stopPropagation: () => { stoppedDesktopMouse = true; },
            });
            assert.equal(stoppedDesktopMouse, false, 'Should allow mouse drag-and-drop on desktop');

            // 5. Touch pointerdown on phone (folded / coarse pointer) MUST still be stopped
            isCoarsePointer = true;
            let stoppedPhoneTouch = false;
            fireDocEvent('pointerdown', {
                pointerType: 'touch',
                target: makeTarget('[aria-haspopup]'),
                stopPropagation: () => { stoppedPhoneTouch = true; },
            });
            assert.equal(stoppedPhoneTouch, true, 'Should stop pointerdown on touch input even when folded');

            // 6. Native dragstart in sidebar on touch/unfolded MUST be prevented and stopped
            let preventedDragStart = false;
            let stoppedDragStart = false;
            fireDocEvent('dragstart', {
                pointerType: 'touch',
                target: makeTarget(null),
                preventDefault: () => { preventedDragStart = true; },
                stopPropagation: () => { stoppedDragStart = true; },
            });
            assert.equal(preventedDragStart, true, 'Should preventDefault on dragstart in sidebar on touch');
            assert.equal(stoppedDragStart, true, 'Should stopPropagation on dragstart in sidebar on touch');
        });

        await t.test('Pre-init script converts plain Enter to Shift+Enter (line break) in 50/50 split mode', () => {
            const vm = require('node:vm');
            const { buildPreInitScript } = require('../proxy/lib/ui-injection');

            const docListeners = {};
            class FakeHTMLElement {}

            let isUnfoldedViewport = true;
            let typeaheadOpenInDom = false;

            const sandbox = {
                window: {
                    get innerWidth() { return isUnfoldedViewport ? 800 : 1440; },
                    get innerHeight() { return isUnfoldedViewport ? 850 : 900; },
                    matchMedia: () => ({ matches: isUnfoldedViewport }),
                    addEventListener: () => {},
                    localStorage: { getItem: () => null, removeItem: () => {} },
                },
                navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14)', maxTouchPoints: 5 },
                document: {
                    readyState: 'loading',
                    title: 'Antigravity',
                    documentElement: {
                        style: { setProperty: () => {}, removeProperty: () => {} },
                        classList: {
                            toggle: () => {},
                            contains: (cls) => cls === 'agy-unfolded' && isUnfoldedViewport,
                        },
                        appendChild: () => {},
                    },
                    addEventListener: (type, fn, capture) => {
                        if (!docListeners[type]) docListeners[type] = [];
                        docListeners[type].push({ fn, capture });
                    },
                    getElementById: () => null,
                    querySelector: (sel) => {
                        if (sel.includes('Typeahead menu') && typeaheadOpenInDom) return {};
                        return null;
                    },
                    querySelectorAll: () => [],
                    createElement: () => ({
                        style: {},
                        getBoundingClientRect: () => ({ height: 0 }),
                        remove: () => {},
                    }),
                },
                HTMLElement: FakeHTMLElement,
                Document: function() {},
                HTMLDocument: function() {},
                Object,
                String,
                Number,
                Math,
                setTimeout,
            };

            vm.runInNewContext(buildPreInitScript(), sandbox);

            function fireKeyDown(eventObj) {
                for (const l of docListeners['keydown'] || []) {
                    l.fn(eventObj);
                }
            }

            function makePromptTarget(attrs = {}) {
                const defaultAttrs = {
                    contenteditable: 'true',
                    role: 'combobox',
                    'aria-label': 'Message input',
                    'aria-expanded': 'false',
                    ...attrs,
                };
                const host = {
                    tagName: 'DIV',
                    contentEditable: 'true',
                    getAttribute: (name) => defaultAttrs[name.toLowerCase()] ?? null,
                    closest: (sel) => {
                        if (sel.includes('monaco-editor')) return null;
                        if (sel.includes('contenteditable')) return host;
                        return null;
                    }
                };
                return host;
            }

            // 1. Plain Enter in 50/50 split mode on prompt input -> sets shiftKey = true so Lexical inserts line break
            const enterEvt1 = {
                key: 'Enter',
                shiftKey: false,
                ctrlKey: false,
                metaKey: false,
                altKey: false,
                target: makePromptTarget(),
            };
            fireKeyDown(enterEvt1);
            assert.equal(enterEvt1.shiftKey, true, 'Plain Enter in 50/50 split mode should set shiftKey=true to add a return');

            // 2. Enter when slash-command / mention typeahead menu is open (aria-expanded="true") -> leaves shiftKey = false
            const enterEvtMenu = {
                key: 'Enter',
                shiftKey: false,
                ctrlKey: false,
                metaKey: false,
                altKey: false,
                target: makePromptTarget({ 'aria-expanded': 'true' }),
            };
            fireKeyDown(enterEvtMenu);
            assert.equal(enterEvtMenu.shiftKey, false, 'Enter with aria-expanded="true" should not set shiftKey so autocomplete item can be selected');

            // 3. Enter when Typeahead menu listbox is in DOM -> leaves shiftKey = false
            typeaheadOpenInDom = true;
            const enterEvtListbox = {
                key: 'Enter',
                shiftKey: false,
                ctrlKey: false,
                metaKey: false,
                altKey: false,
                target: makePromptTarget(),
            };
            fireKeyDown(enterEvtListbox);
            assert.equal(enterEvtListbox.shiftKey, false, 'Enter with Typeahead menu listbox in DOM should not set shiftKey');
            typeaheadOpenInDom = false;

            // 4. Enter on a single-line <input> (e.g. sidebar rename or search) -> leaves shiftKey = false
            const inputHost = {
                tagName: 'INPUT',
                getAttribute: (name) => name === 'type' ? 'text' : null,
                closest: () => inputHost,
            };
            const enterEvtInput = {
                key: 'Enter',
                shiftKey: false,
                ctrlKey: false,
                metaKey: false,
                altKey: false,
                target: inputHost,
            };
            fireKeyDown(enterEvtInput);
            assert.equal(enterEvtInput.shiftKey, false, 'Enter on <input> should not set shiftKey');

            // 5. Ctrl+Enter in 50/50 split mode -> leaves shiftKey = false so hardware keyboard can still submit
            const ctrlEnterEvt = {
                key: 'Enter',
                shiftKey: false,
                ctrlKey: true,
                metaKey: false,
                altKey: false,
                target: makePromptTarget(),
            };
            fireKeyDown(ctrlEnterEvt);
            assert.equal(ctrlEnterEvt.shiftKey, false, 'Ctrl+Enter should not set shiftKey');

            // 6. Plain Enter on desktop (not unfolded 50/50 mode) -> leaves shiftKey = false
            isUnfoldedViewport = false;
            const desktopEnterEvt = {
                key: 'Enter',
                shiftKey: false,
                ctrlKey: false,
                metaKey: false,
                altKey: false,
                target: makePromptTarget(),
            };
            fireKeyDown(desktopEnterEvt);
            assert.equal(desktopEnterEvt.shiftKey, false, 'Plain Enter on desktop should remain untouched');
        });
    } finally {
        proxyProc.kill('SIGTERM');
        await new Promise((resolve) => mockAgyServer.close(resolve));
    }
});


