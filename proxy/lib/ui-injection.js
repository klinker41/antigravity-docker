'use strict';

const { ENABLE_IDE, ENABLE_TERMINAL } = require('./config');

// SVG icons used in the injected sidebar buttons
const SIDECAR_ICON_SVG = `<svg class="agy-injected-btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`;
const MODELS_ICON_SVG = `<svg class="agy-injected-btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-4 4 4 4 0 0 1-4-4V6a4 4 0 0 1 4-4z"></path><path d="M18 14v1a6 6 0 0 1-12 0v-1"></path><path d="M12 18v4"></path><path d="M8 22h8"></path></svg>`;
const IDE_ICON_SVG = `<svg class="agy-injected-btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`;
const TERMINAL_ICON_SVG = `<svg class="agy-injected-btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`;

// Injected CSS Styles for Antigravity UI buttons
const INJECTED_UI_STYLES = `
/* Google Antigravity Injected Tools Navigation */
.agy-injected-tools-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    border: none;
    width: 100%;
}

.agy-injected-tools-label {
    display: none !important;
}

.agy-injected-btn {
    display: inline-flex;
    align-items: center;
    width: 100%;
    height: 32px;
    padding: 4px 8px;
    gap: 6px;
    border-radius: 8px;
    color: var(--secondary-foreground, #9d9d9d);
    text-decoration: none;
    font-size: 14px;
    font-weight: 400;
    line-height: 20px;
    transition: background-color 150ms ease, color 150ms ease;
    background: transparent;
    border: none;
    user-select: none;
    cursor: pointer;
    box-sizing: border-box;
}

.agy-injected-btn:hover {
    background: var(--sidebar-muted, rgba(255, 255, 255, 0.05));
    color: var(--foreground, #ffffff);
    transform: none;
    box-shadow: none;
    border-color: transparent;
}

.agy-injected-btn:active {
    background: var(--sidebar-secondary, rgba(255, 255, 255, 0.08));
}

.agy-injected-btn-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: currentColor;
    stroke: currentColor;
    transition: none;
}

.agy-injected-btn:hover .agy-injected-btn-icon {
    color: currentColor;
    stroke: currentColor;
    transform: none;
}

.agy-injected-btn-sidecars .agy-injected-btn-icon,
.agy-injected-btn-models .agy-injected-btn-icon,
.agy-injected-btn-ide .agy-injected-btn-icon,
.agy-injected-btn-terminal .agy-injected-btn-icon {
    color: currentColor;
    stroke: currentColor;
}

.agy-injected-btn-text {
    flex-grow: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 14px;
    font-weight: 400;
}

/* Hide injected workspace tools on narrow folded mobile layouts */
@media (max-width: 768px) {
    :root:not(.agy-unfolded) .agy-injected-tools-group {
        display: none !important;
    }
}
`;

// Build pre-init script executed in <head> before main.js boots
function buildPreInitScript() {
    return `
(function initAntigravityPreInit() {
    function isFoldableUnfolded() {
        if (typeof window === 'undefined') return false;
        var w = window.innerWidth;
        var h = window.innerHeight;
        var hasTouch = typeof navigator !== 'undefined' && (navigator.maxTouchPoints > 0 || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches));
        var isSquarish = (w / h) >= 0.65 && (w / h) <= 1.5;
        if (w >= 480 && w <= 1050 && isSquarish) return true;
        if (hasTouch && w >= 480 && w <= 1150 && (w / h) >= 0.65) return true;
        return false;
    }

    try {
        var currentSw = Number(localStorage.getItem('sidebarWidth'));
        if (currentSw > 450) {
            localStorage.removeItem('sidebarWidth');
        }
    } catch (e) {}

    try {
        var realUA = navigator.userAgent;
        Object.defineProperty(navigator, 'userAgent', {
            get: function() {
                if (isFoldableUnfolded()) {
                    return realUA.replace(/Android[^;)]*/i, 'Linux x86_64').replace(/Mobile\\s*/i, '');
                }
                return realUA;
            },
            configurable: true
        });
    } catch (e) {}

    function updateFoldState() {
        var unfolded = isFoldableUnfolded();
        if (document.documentElement) {
            document.documentElement.classList.toggle('agy-unfolded', unfolded);
        }
    }
    updateFoldState();

    function updateVisualViewport() {
        if (!window.visualViewport) return;
        var h = window.visualViewport.height;
        if (document.documentElement) {
            document.documentElement.style.setProperty('--visual-viewport-height', h + 'px');
        }
    }

    function updateDynamicBottomPadding() {
        if (typeof window === 'undefined') return;

        // 1. Probe W3C env(safe-area-inset-bottom)
        var probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;bottom:0;left:0;height:env(safe-area-inset-bottom,0px);pointer-events:none;visibility:hidden;z-index:-9999;';
        (document.body || document.documentElement).appendChild(probe);
        var inset = probe.getBoundingClientRect().height || 0;
        probe.remove();

        // 2. Fallback check for mobile touch devices with a system navigation bar
        if (inset === 0) {
            var hasTouch = typeof navigator !== 'undefined' && (
                navigator.maxTouchPoints > 0 ||
                (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
            );
            var isKeyboardOpen = window.visualViewport && window.visualViewport.height < window.innerHeight * 0.75;
            if (hasTouch && !isKeyboardOpen && window.screen && window.screen.height && window.screen.availHeight) {
                var diff = window.screen.height - window.screen.availHeight;
                if (diff >= 12 && diff <= 72) {
                    inset = diff;
                }
            }
        }

        var padVal = inset > 0 ? (inset + 'px') : '0px';
        if (document.documentElement) {
            document.documentElement.style.setProperty('--safe-area-bottom', padVal);
        }
        var layoutContainer = document.querySelector('.h-screen.w-screen') || document.getElementById('root');
        if (layoutContainer) {
            layoutContainer.style.setProperty('--safe-area-bottom', padVal);
        }
    }

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', function() {
            updateVisualViewport();
            updateDynamicBottomPadding();
        });
        window.visualViewport.addEventListener('scroll', function() {
            updateVisualViewport();
            updateDynamicBottomPadding();
        });
        updateVisualViewport();
    }
    updateDynamicBottomPadding();

    var lastUnfoldedState = isFoldableUnfolded();
    window.addEventListener('resize', function() {
        updateFoldState();
        updateVisualViewport();
        updateDynamicBottomPadding();
        var currentUnfolded = isFoldableUnfolded();
        if (currentUnfolded !== lastUnfoldedState) {
            lastUnfoldedState = currentUnfolded;
            window.location.reload();
        }
    });
    window.addEventListener('orientationchange', function() {
        setTimeout(updateDynamicBottomPadding, 100);
    });
    window.addEventListener('focusin', function() {
        setTimeout(updateDynamicBottomPadding, 150);
    });
    window.addEventListener('focusout', function() {
        setTimeout(updateDynamicBottomPadding, 150);
    });

    // 6. Smooth scroll to prompt box when virtual keyboard opens
    document.addEventListener('focusin', function(e) {
        if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.isContentEditable)) {
            setTimeout(function() {
                try {
                    e.target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
                } catch (err) {}
            }, 150);
            setTimeout(function() {
                try {
                    e.target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
                } catch (err) {}
            }, 350);
        }
    });

    // 7. Enforce sentence case capitalization and Android typo autocorrect on message boxes
    function isMessageOrTextInput(el) {
        if (!el || typeof el.getAttribute !== 'function') return false;
        if (el.tagName === 'CODE' || el.tagName === 'PRE') return false;
        if (el.tagName === 'INPUT') {
            var type = (el.getAttribute('type') || '').toLowerCase();
            if (type === 'password' || type === 'email' || type === 'url' || type === 'number' || type === 'search' || type === 'hidden') return false;
        }
        if (el.closest && el.closest('.monaco-editor, .terminal, .xterm')) return false;
        var ce = el.getAttribute('contenteditable');
        var role = el.getAttribute('role');
        return ce === 'true' || ce === '' || el.contentEditable === 'true' || role === 'textbox' || role === 'combobox' || el.tagName === 'TEXTAREA' || (el.getAttribute('aria-label') || '').toLowerCase().includes('message');
    }

    var origSetAttr = HTMLElement.prototype.setAttribute;
    var origRemAttr = HTMLElement.prototype.removeAttribute;

    function enforceInputTypingAttributes(el) {
        if (!isMessageOrTextInput(el)) return;
        if (el.getAttribute('autocapitalize') !== 'sentences') {
            origSetAttr.call(el, 'autocapitalize', 'sentences');
        }
        if (el.getAttribute('autocorrect') !== 'on') {
            origSetAttr.call(el, 'autocorrect', 'on');
        }
        if (el.getAttribute('spellcheck') !== 'true') {
            origSetAttr.call(el, 'spellcheck', 'true');
        }
        if (el.getAttribute('autocomplete') !== 'on') {
            origSetAttr.call(el, 'autocomplete', 'on');
        }
    }

    try {
        HTMLElement.prototype.setAttribute = function(name, value) {
            if (typeof name === 'string') {
                var lower = name.toLowerCase();
                var strVal = String(value).toLowerCase();
                if (lower === 'autocapitalize' && (strVal === 'off' || strVal === 'none')) {
                    if (isMessageOrTextInput(this)) {
                        return origSetAttr.call(this, name, 'sentences');
                    }
                }
                if (lower === 'autocorrect' && (strVal === 'off' || strVal === 'false' || strVal === 'none')) {
                    if (isMessageOrTextInput(this)) {
                        return origSetAttr.call(this, name, 'on');
                    }
                }
                if (lower === 'spellcheck' && (strVal === 'false' || strVal === 'off')) {
                    if (isMessageOrTextInput(this)) {
                        return origSetAttr.call(this, name, 'true');
                    }
                }
                if (lower === 'autocomplete' && (strVal === 'off' || strVal === 'none')) {
                    if (isMessageOrTextInput(this)) {
                        return origSetAttr.call(this, name, 'on');
                    }
                }
            }
            var res = origSetAttr.call(this, name, value);
            if (typeof name === 'string') {
                var l = name.toLowerCase();
                if (l === 'contenteditable' || l === 'role' || l === 'aria-label') {
                    enforceInputTypingAttributes(this);
                }
            }
            return res;
        };

        HTMLElement.prototype.removeAttribute = function(name) {
            if (typeof name === 'string') {
                var lower = name.toLowerCase();
                if (lower === 'autocapitalize' && isMessageOrTextInput(this)) {
                    return origSetAttr.call(this, name, 'sentences');
                }
                if (lower === 'autocorrect' && isMessageOrTextInput(this)) {
                    return origSetAttr.call(this, name, 'on');
                }
                if (lower === 'spellcheck' && isMessageOrTextInput(this)) {
                    return origSetAttr.call(this, name, 'true');
                }
                if (lower === 'autocomplete' && isMessageOrTextInput(this)) {
                    return origSetAttr.call(this, name, 'on');
                }
            }
            return origRemAttr.call(this, name);
        };

        var ceDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'contentEditable');
        if (ceDesc && ceDesc.set) {
            Object.defineProperty(HTMLElement.prototype, 'contentEditable', {
                get: function() { return ceDesc.get.call(this); },
                set: function(val) {
                    var r = ceDesc.set.call(this, val);
                    if (val === 'true' || val === true || val === '') {
                        enforceInputTypingAttributes(this);
                    }
                    return r;
                },
                configurable: true
            });
        }

        var scDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'spellcheck');
        if (scDesc && scDesc.set) {
            Object.defineProperty(HTMLElement.prototype, 'spellcheck', {
                get: function() { return scDesc.get.call(this); },
                set: function(val) {
                    if (!val && isMessageOrTextInput(this)) {
                        return scDesc.set.call(this, true);
                    }
                    return scDesc.set.call(this, val);
                },
                configurable: true
            });
        }
    } catch (e) {}

    function applySentenceCapitalization(target) {
        if (!target) return;
        var editables = target.querySelectorAll ? target.querySelectorAll('[contenteditable="true"], [role="textbox"], [role="combobox"], [aria-label*="Message"], [aria-label*="message"], textarea') : [];
        for (var i = 0; i < editables.length; i++) {
            enforceInputTypingAttributes(editables[i]);
        }
    }

    document.addEventListener('pointerdown', function(e) {
        if (!e.target) return;
        var host = e.target.closest ? (e.target.closest('[contenteditable="true"], [role="textbox"], [role="combobox"], textarea, input') || e.target) : e.target;
        enforceInputTypingAttributes(host);
    }, true);

    document.addEventListener('focusin', function(e) {
        if (!e.target) return;
        var host = e.target.closest ? (e.target.closest('[contenteditable="true"], [role="textbox"], [role="combobox"], textarea, input') || e.target) : e.target;
        enforceInputTypingAttributes(host);
    }, true);

    // 8. Sanitize product name and window title (remove trailing 'CLI')
    try {
        if (window.__APP_CONFIG__) {
            window.__APP_CONFIG__.productName = 'antigravity';
        }
        var appConfigVal = window.__APP_CONFIG__;
        Object.defineProperty(window, '__APP_CONFIG__', {
            get: function() { return appConfigVal; },
            set: function(val) {
                if (val && typeof val === 'object' && val.productName) {
                    val.productName = val.productName.replace(/-cli$/i, '');
                }
                appConfigVal = val;
            },
            configurable: true
        });
    } catch (e) {}

    function sanitizeDocumentTitle() {
        if (typeof document !== 'undefined' && document.title && /antigravity\s+cli/i.test(document.title)) {
            document.title = document.title.replace(/\s+cli\b/gi, '');
        }
    }
    sanitizeDocumentTitle();

    try {
        var origTitleDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'title') ||
                            Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'title');
        if (origTitleDesc && origTitleDesc.set) {
            var origSetTitle = origTitleDesc.set;
            Object.defineProperty(document, 'title', {
                get: function() { return origTitleDesc.get.call(this); },
                set: function(val) {
                    if (typeof val === 'string') {
                        val = val.replace(/\s+cli\b/gi, '');
                    }
                    return origSetTitle.call(this, val);
                },
                configurable: true
            });
        }
    } catch (e) {}

    function sanitizeTitleTextNodes() {
        sanitizeDocumentTitle();
        var headings = document.querySelectorAll('h1, h2, h3, span, a, div');
        for (var i = 0; i < headings.length; i++) {
            var node = headings[i];
            if (node.childNodes.length === 1 && node.childNodes[0].nodeType === 3 && node.textContent.trim() === 'Antigravity CLI') {
                node.textContent = 'Antigravity';
            }
        }
    }

    // 9. Sync sidebar width to CSS custom property --sidebar-width via ResizeObserver
    function syncSidebarWidth() {
        var sidebar = document.querySelector('[role="navigation"][aria-label="Sidebar"]');
        var sidebarPane = sidebar
            ? (sidebar.parentElement?.closest('div[style*="container-type"] > div:first-child') || sidebar.parentElement)
            : null;
        var isUnfolded = isFoldableUnfolded();

        if (sidebar && sidebarPane && isUnfolded) {
            var parent = sidebar.parentElement;
            if (parent && parent !== sidebarPane) {
                parent.style.setProperty('width', '100%', 'important');
                parent.style.setProperty('max-width', '100%', 'important');
                parent.style.setProperty('min-width', '100%', 'important');
                parent.style.setProperty('left', '0px', 'important');
                parent.style.setProperty('right', '0px', 'important');
                parent.style.setProperty('position', 'relative', 'important');
            }
            var halfW = Math.round(window.innerWidth / 2);
            if (document.documentElement) {
                document.documentElement.style.setProperty('--sidebar-width', halfW + 'px');
            }
            var layoutContainer = document.querySelector('.h-screen.w-screen') || document.getElementById('root');
            if (layoutContainer) {
                layoutContainer.style.setProperty('--sidebar-width', halfW + 'px');
            }
        }

        if (sidebarPane && window.ResizeObserver && !sidebarPane.__hasResizeObserver) {
            sidebarPane.__hasResizeObserver = true;
            new ResizeObserver(function(entries) {
                for (var i = 0; i < entries.length; i++) {
                    var w = entries[i].contentRect ? entries[i].contentRect.width : entries[i].target.getBoundingClientRect().width;
                    if (isFoldableUnfolded()) {
                        w = Math.round(window.innerWidth / 2);
                    }
                    if (w > 50 && document.documentElement) {
                        document.documentElement.style.setProperty('--sidebar-width', w + 'px');
                        var lc = document.querySelector('.h-screen.w-screen') || document.getElementById('root');
                        if (lc) lc.style.setProperty('--sidebar-width', w + 'px');
                    } else if (document.documentElement && !isFoldableUnfolded()) {
                        document.documentElement.style.removeProperty('--sidebar-width');
                    }
                }
            }).observe(sidebarPane);
        } else if (sidebarPane && document.documentElement && !isUnfolded) {
            var rect = sidebarPane.getBoundingClientRect();
            if (rect.width > 50) {
                document.documentElement.style.setProperty('--sidebar-width', rect.width + 'px');
            } else {
                document.documentElement.style.removeProperty('--sidebar-width');
            }
        }
    }
    window.addEventListener('resize', syncSidebarWidth);

    // 10. Disable drag-and-drop project/conversation reordering in unfolded mode or touch scrolling
    function shouldDisableSidebarDnd(e) {
        if (e && e.pointerType === 'touch') return true;
        if (isFoldableUnfolded()) return true;
        if (document.documentElement && document.documentElement.classList.contains('agy-unfolded')) return true;
        if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches && (!e || e.pointerType !== 'mouse')) return true;
        return false;
    }

    function isInsideSidebarScrollArea(target) {
        var el = (target && target.nodeType === 3) ? target.parentElement : target;
        if (!el || typeof el.closest !== 'function') return null;

        // Allow inline rename inputs and explicit [data-no-drag] / popover menu buttons (do NOT exempt [aria-haspopup] because mE ContextMenu wraps every project-header with aria-haspopup="menu")
        if (el.closest('input, textarea, [contenteditable="true"], [data-no-drag], .popover-trigger-element, [role="menuitem"], [role="menu"]')) {
            return null;
        }

        var directItem = el.closest('[data-project-card], [data-testid="project-header"], [data-sidebar-row-id], [data-testid^="conversation-row-"], [data-testid="conversation-group-header"], [data-sidebar-scroll-container], [data-testid="conversation-list-sidebar"]');
        if (directItem) return el;

        var sidebar = el.closest('[role="navigation"][aria-label="Sidebar"], div.bg-sidebar');
        if (!sidebar) return null;

        var scrollContainer = el.closest('.overflow-y-auto, [data-sidebar-scroll-container]');
        if (scrollContainer && sidebar.contains(scrollContainer)) {
            return el;
        }
        return null;
    }

    var activeSidebarTouchScroll = false;

    function handleSidebarPointerDownCapture(e) {
        if (!shouldDisableSidebarDnd(e)) {
            activeSidebarTouchScroll = false;
            return;
        }
        var el = isInsideSidebarScrollArea(e.target);
        if (!el) {
            activeSidebarTouchScroll = false;
            return;
        }

        activeSidebarTouchScroll = true;
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') {
            e.stopImmediatePropagation();
        }
    }

    function handleSidebarPointerMoveCapture(e) {
        if (!shouldDisableSidebarDnd(e)) return;
        if (activeSidebarTouchScroll || isInsideSidebarScrollArea(e.target)) {
            e.stopPropagation();
            if (typeof e.stopImmediatePropagation === 'function') {
                e.stopImmediatePropagation();
            }
        }
    }

    function handleSidebarPointerEndCapture() {
        activeSidebarTouchScroll = false;
    }

    window.addEventListener('pointerdown', handleSidebarPointerDownCapture, true);
    document.addEventListener('pointerdown', handleSidebarPointerDownCapture, true);
    window.addEventListener('pointermove', handleSidebarPointerMoveCapture, true);
    document.addEventListener('pointermove', handleSidebarPointerMoveCapture, true);
    window.addEventListener('pointerup', handleSidebarPointerEndCapture, true);
    window.addEventListener('pointercancel', handleSidebarPointerEndCapture, true);

    document.addEventListener('dragstart', function(e) {
        if (!shouldDisableSidebarDnd(e)) return;
        if (isInsideSidebarScrollArea(e.target)) {
            e.preventDefault();
            e.stopPropagation();
            if (typeof e.stopImmediatePropagation === 'function') {
                e.stopImmediatePropagation();
            }
        }
    }, true);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            applySentenceCapitalization(document.body);
            sanitizeTitleTextNodes();
            syncSidebarWidth();
        });
    } else {
        applySentenceCapitalization(document.body);
        sanitizeTitleTextNodes();
        syncSidebarWidth();
    }
    window.addEventListener('load', function() {
        sanitizeTitleTextNodes();
        syncSidebarWidth();
    });
})();
`;
}

// Build dynamically injected script for Left-hand Navigation Tools
function buildInjectedScript() {
    const sidecarButtonHtml = `
            <a href="/sidecars" target="_blank" rel="noopener noreferrer" class="agy-injected-btn agy-injected-btn-sidecars inline-flex items-center transition-colors select-none outline-none cursor-pointer flex-grow w-full justify-start font-normal h-8 min-w-0 gap-1.5 px-2 py-1 rounded-lg bg-transparent text-secondary-foreground hover:bg-sidebar-muted hover:text-foreground" title="Sidecar Manager">
                <span class="shrink-0 flex items-center">${SIDECAR_ICON_SVG}</span>
                <span class="truncate text-sm agy-injected-btn-text">Sidecar Manager</span>
            </a>`;

    const modelsButtonHtml = `
            <a href="/models" target="_blank" rel="noopener noreferrer" class="agy-injected-btn agy-injected-btn-models inline-flex items-center transition-colors select-none outline-none cursor-pointer flex-grow w-full justify-start font-normal h-8 min-w-0 gap-1.5 px-2 py-1 rounded-lg bg-transparent text-secondary-foreground hover:bg-sidebar-muted hover:text-foreground" title="Custom Models">
                <span class="shrink-0 flex items-center">${MODELS_ICON_SVG}</span>
                <span class="truncate text-sm agy-injected-btn-text">Custom Models</span>
            </a>`;

    const ideButtonHtml = ENABLE_IDE ? `
            <a href="/ide/" target="_blank" rel="noopener noreferrer" class="agy-injected-btn agy-injected-btn-ide inline-flex items-center transition-colors select-none outline-none cursor-pointer flex-grow w-full justify-start font-normal h-8 min-w-0 gap-1.5 px-2 py-1 rounded-lg bg-transparent text-secondary-foreground hover:bg-sidebar-muted hover:text-foreground" title="Web IDE">
                <span class="shrink-0 flex items-center">${IDE_ICON_SVG}</span>
                <span class="truncate text-sm agy-injected-btn-text">Web IDE</span>
            </a>` : '';

    const termButtonHtml = ENABLE_TERMINAL ? `
            <a href="/terminal/" target="_blank" rel="noopener noreferrer" class="agy-injected-btn agy-injected-btn-terminal inline-flex items-center transition-colors select-none outline-none cursor-pointer flex-grow w-full justify-start font-normal h-8 min-w-0 gap-1.5 px-2 py-1 rounded-lg bg-transparent text-secondary-foreground hover:bg-sidebar-muted hover:text-foreground" title="Host Terminal">
                <span class="shrink-0 flex items-center">${TERMINAL_ICON_SVG}</span>
                <span class="truncate text-sm agy-injected-btn-text">Host Terminal</span>
            </a>` : '';

    return `
(function initAntigravityCustomTools() {
    function createToolsElement() {
        const container = document.createElement('div');
        container.id = 'agy-injected-tools-group';
        container.className = 'agy-injected-tools-group';
        container.innerHTML = \`${sidecarButtonHtml}${modelsButtonHtml}${ideButtonHtml}${termButtonHtml}\`;
        return container;
    }

    function tryInjectSidebar() {
        const sidebar = document.querySelector('[role="navigation"][aria-label="Sidebar"], div.bg-sidebar');
        if (!sidebar) return;

        let toolsEl = document.getElementById('agy-injected-tools-group');
        if (!toolsEl) {
            toolsEl = createToolsElement();
        }

        // Look for Customizations entry in the sidebar navigation
        let customizationsEl = null;
        const candidates = sidebar.querySelectorAll('button, a, div[role="button"]');
        for (let i = 0; i < candidates.length; i++) {
            const el = candidates[i];
            const text = (el.textContent || '').trim();
            const href = el.getAttribute('href') || '';
            const testid = el.getAttribute('data-testid') || '';
            if (
                text === 'Customizations' ||
                href.includes('/customizations') ||
                testid.includes('customization') ||
                (text.startsWith('Customizations') && text.length < 30)
            ) {
                customizationsEl = el;
                break;
            }
        }

        if (customizationsEl) {
            const target = (customizationsEl.parentElement && customizationsEl.parentElement.classList.contains('flex-col'))
                ? customizationsEl
                : (customizationsEl.closest('li, div.flex-grow') || customizationsEl);
            if (toolsEl.previousElementSibling !== target) {
                if (target.nextSibling) {
                    target.parentNode.insertBefore(toolsEl, target.nextSibling);
                } else {
                    target.parentNode.appendChild(toolsEl);
                }
            }
            return;
        }

        // Fallback: settings button or footer section if customizations button not rendered yet
        if (!document.getElementById('agy-injected-tools-group')) {
            const settingsBtn = sidebar.querySelector('button[data-testid="settings-button"]');
            if (settingsBtn && settingsBtn.parentElement) {
                settingsBtn.parentElement.insertBefore(toolsEl, settingsBtn);
            } else {
                const footerSection = sidebar.querySelector('div.flex.flex-col.gap-px.pt-2.px-2') || sidebar.lastElementChild;
                if (footerSection && footerSection !== sidebar) {
                    sidebar.insertBefore(toolsEl, footerSection);
                } else {
                    sidebar.appendChild(toolsEl);
                }
            }
        }
    }

    function enforceFavicon() {
        const icons = document.querySelectorAll("link[rel*='icon']");
        if (icons.length === 0) {
            const icon = document.createElement('link');
            icon.rel = 'icon';
            icon.type = 'image/svg+xml';
            icon.href = '/favicon.svg';
            document.head.appendChild(icon);
        } else {
            for (const icon of icons) {
                if (icon.getAttribute('href') !== '/favicon.svg') {
                    icon.setAttribute('type', 'image/svg+xml');
                    icon.setAttribute('href', '/favicon.svg');
                }
            }
        }
    }

    function runInjection() {
        enforceFavicon();
        tryInjectSidebar();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runInjection);
    } else {
        runInjection();
    }

    const observer = new MutationObserver(() => {
        enforceFavicon();
        tryInjectSidebar();
    });

    observer.observe(document.body, { childList: true, subtree: true });
    if (document.head) {
        observer.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    }
})();
`;
}

module.exports = {
    INJECTED_UI_STYLES,
    buildPreInitScript,
    buildInjectedScript,
};
