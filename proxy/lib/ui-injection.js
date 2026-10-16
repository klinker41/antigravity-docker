'use strict';

const { ENABLE_IDE, ENABLE_TERMINAL } = require('./config');

// SVG icons used in the injected sidebar buttons
const SIDECAR_ICON_SVG = `<svg class="agy-injected-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`;
const MODELS_ICON_SVG = `<svg class="agy-injected-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-4 4 4 4 0 0 1-4-4V6a4 4 0 0 1 4-4z"></path><path d="M18 14v1a6 6 0 0 1-12 0v-1"></path><path d="M12 18v4"></path><path d="M8 22h8"></path></svg>`;
const IDE_ICON_SVG = `<svg class="agy-injected-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`;
const TERMINAL_ICON_SVG = `<svg class="agy-injected-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`;
const EXTERNAL_ICON_SVG = `<svg class="agy-injected-external-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;

// Injected CSS Styles for Antigravity UI buttons
const INJECTED_UI_STYLES = `
/* Google Antigravity Injected Tools Navigation & Floating Dock */
.agy-injected-tools-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 8px 12px;
    padding: 8px 0;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.agy-injected-tools-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: rgba(255, 255, 255, 0.4);
    padding: 2px 8px 4px 8px;
    user-select: none;
}

.agy-injected-btn {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-radius: 8px;
    color: #e2e8f0;
    text-decoration: none;
    font-size: 13px;
    font-weight: 500;
    transition: all 0.2s ease;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    user-select: none;
    cursor: pointer;
}

.agy-injected-btn:hover {
    background: rgba(66, 133, 244, 0.12);
    border-color: rgba(66, 133, 244, 0.35);
    color: #ffffff;
    transform: translateX(2px);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
}

.agy-injected-btn-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    color: #38bdf8;
    transition: transform 0.2s ease;
}

.agy-injected-btn:hover .agy-injected-btn-icon {
    transform: scale(1.1);
    color: #60a5fa;
}

.agy-injected-btn-sidecars .agy-injected-btn-icon {
    color: #a78bfa;
}

.agy-injected-btn-sidecars:hover .agy-injected-btn-icon {
    color: #c4b5fd;
}

.agy-injected-btn-models .agy-injected-btn-icon {
    color: #f59e0b;
}

.agy-injected-btn-models:hover .agy-injected-btn-icon {
    color: #fbbf24;
}

.agy-injected-btn-terminal .agy-injected-btn-icon {
    color: #4ade80;
}

.agy-injected-btn-terminal:hover .agy-injected-btn-icon {
    color: #86efac;
}

.agy-injected-btn-text {
    flex-grow: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.agy-injected-external-icon {
    width: 12px;
    height: 12px;
    opacity: 0.4;
    flex-shrink: 0;
    transition: opacity 0.2s ease;
}

.agy-injected-btn:hover .agy-injected-external-icon {
    opacity: 0.9;
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
        // Foldable unfolded: wide screen (>=480px) with squarish or wider aspect ratio (>=0.65), or >=768px
        return (w >= 480 && (w / h) >= 0.65) || w >= 768;
    }

    if (isFoldableUnfolded()) {
        try {
            var currentSw = localStorage.getItem('sidebarWidth');
            if (!currentSw || currentSw === '256') {
                localStorage.setItem('sidebarWidth', String(Math.round(window.innerWidth / 2)));
            }
        } catch (e) {}
    }

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
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', updateVisualViewport);
        window.visualViewport.addEventListener('scroll', updateVisualViewport);
        updateVisualViewport();
    }

    var lastUnfoldedState = isFoldableUnfolded();
    window.addEventListener('resize', function() {
        updateFoldState();
        updateVisualViewport();
        var currentUnfolded = isFoldableUnfolded();
        if (currentUnfolded !== lastUnfoldedState) {
            lastUnfoldedState = currentUnfolded;
            window.location.reload();
        }
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

    // 7. Enforce sentence case capitalization on message boxes and text inputs
    function isMessageOrTextInput(el) {
        if (!el || typeof el.getAttribute !== 'function') return false;
        if (el.tagName === 'INPUT') {
            var type = (el.getAttribute('type') || '').toLowerCase();
            if (type === 'password' || type === 'email' || type === 'url' || type === 'number') return false;
        }
        if (el.closest && el.closest('.monaco-editor, .terminal, .xterm')) return false;
        return el.isContentEditable || el.getAttribute('role') === 'textbox' || el.tagName === 'TEXTAREA' || (el.getAttribute('aria-label') || '').toLowerCase().includes('message');
    }

    try {
        var origSetAttr = HTMLElement.prototype.setAttribute;
        var origRemAttr = HTMLElement.prototype.removeAttribute;

        HTMLElement.prototype.setAttribute = function(name, value) {
            if (typeof name === 'string' && name.toLowerCase() === 'autocapitalize' && (value === 'off' || value === 'none')) {
                if (isMessageOrTextInput(this)) {
                    return origSetAttr.call(this, name, 'sentences');
                }
            }
            return origSetAttr.call(this, name, value);
        };

        HTMLElement.prototype.removeAttribute = function(name) {
            if (typeof name === 'string' && name.toLowerCase() === 'autocapitalize') {
                if (isMessageOrTextInput(this)) {
                    return origSetAttr.call(this, name, 'sentences');
                }
            }
            return origRemAttr.call(this, name);
        };
    } catch (e) {}

    function applySentenceCapitalization(target) {
        if (!target) return;
        var editables = target.querySelectorAll ? target.querySelectorAll('[contenteditable="true"], [role="textbox"], textarea') : [];
        for (var i = 0; i < editables.length; i++) {
            var el = editables[i];
            if (isMessageOrTextInput(el) && el.getAttribute('autocapitalize') !== 'sentences') {
                el.setAttribute('autocapitalize', 'sentences');
            }
        }
    }

    document.addEventListener('focusin', function(e) {
        if (e.target && isMessageOrTextInput(e.target)) {
            e.target.setAttribute('autocapitalize', 'sentences');
        }
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
        if (sidebarPane && window.ResizeObserver && !sidebarPane.__hasResizeObserver) {
            sidebarPane.__hasResizeObserver = true;
            new ResizeObserver(function(entries) {
                for (var i = 0; i < entries.length; i++) {
                    var w = entries[i].contentRect ? entries[i].contentRect.width : entries[i].target.getBoundingClientRect().width;
                    if (w > 50 && document.documentElement) {
                        document.documentElement.style.setProperty('--sidebar-width', w + 'px');
                    } else if (document.documentElement) {
                        document.documentElement.style.removeProperty('--sidebar-width');
                    }
                }
            }).observe(sidebarPane);
        } else if (sidebarPane && document.documentElement) {
            var rect = sidebarPane.getBoundingClientRect();
            if (rect.width > 50) {
                document.documentElement.style.setProperty('--sidebar-width', rect.width + 'px');
            } else {
                document.documentElement.style.removeProperty('--sidebar-width');
            }
        }
    }
    window.addEventListener('resize', syncSidebarWidth);

    // 10. Disable drag-and-drop project reordering in unfolded mode or touch scrolling
    function shouldDisableSidebarDnd(e) {
        var isUnfolded = document.documentElement && document.documentElement.classList.contains('agy-unfolded');
        var isTouch = e && e.pointerType === 'touch';
        return isUnfolded || isTouch;
    }

    document.addEventListener('pointerdown', function(e) {
        if (!shouldDisableSidebarDnd(e)) return;

        var sidebar = e.target && e.target.closest ? e.target.closest('[role="navigation"][aria-label="Sidebar"], div.bg-sidebar') : null;
        if (!sidebar) return;

        var scrollContainer = e.target.closest('.overflow-y-auto');
        if (scrollContainer && sidebar.contains(scrollContainer)) {
            if (e.target.closest('button, [role="button"], a, [role="menuitem"], input, textarea')) {
                return;
            }
            e.stopPropagation();
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
            <a href="/sidecars" target="_blank" rel="noopener noreferrer" class="agy-injected-btn agy-injected-btn-sidecars" title="Open Sidecar Manager in a new tab">
                ${SIDECAR_ICON_SVG}
                <span class="agy-injected-btn-text">Sidecar Manager</span>
                ${EXTERNAL_ICON_SVG}
            </a>`;

    const modelsButtonHtml = `
            <a href="/models" target="_blank" rel="noopener noreferrer" class="agy-injected-btn agy-injected-btn-models" title="Configure Custom Models">
                ${MODELS_ICON_SVG}
                <span class="agy-injected-btn-text">Custom Models</span>
                ${EXTERNAL_ICON_SVG}
            </a>`;

    const ideButtonHtml = ENABLE_IDE ? `
            <a href="/ide/" target="_blank" rel="noopener noreferrer" class="agy-injected-btn agy-injected-btn-ide" title="Open VS Code Web IDE in a new tab">
                ${IDE_ICON_SVG}
                <span class="agy-injected-btn-text">Web IDE</span>
                ${EXTERNAL_ICON_SVG}
            </a>` : '';

    const termButtonHtml = ENABLE_TERMINAL ? `
            <a href="/terminal/" target="_blank" rel="noopener noreferrer" class="agy-injected-btn agy-injected-btn-terminal" title="Open Host Terminal in a new tab">
                ${TERMINAL_ICON_SVG}
                <span class="agy-injected-btn-text">Host Terminal</span>
                ${EXTERNAL_ICON_SVG}
            </a>` : '';

    return `
(function initAntigravityCustomTools() {
    function createToolsElement() {
        const container = document.createElement('div');
        container.id = 'agy-injected-tools-group';
        container.className = 'agy-injected-tools-group';
        container.innerHTML = \`<div class="agy-injected-tools-label">Workspace Tools</div>${sidecarButtonHtml}${modelsButtonHtml}${ideButtonHtml}${termButtonHtml}\`;
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
