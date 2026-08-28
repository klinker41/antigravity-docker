'use strict';

const { ENABLE_IDE, ENABLE_TERMINAL } = require('./config');

// SVG icons used in the injected sidebar buttons
const SIDECAR_ICON_SVG = `<svg class="agy-injected-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`;
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

/* Hide injected workspace tools on mobile layouts */
@media (max-width: 768px) {
    .agy-injected-tools-group {
        display: none !important;
    }
}
`;

// Build dynamically injected script for Left-hand Navigation Tools
function buildInjectedScript() {
    const sidecarButtonHtml = `
            <a href="/sidecars" target="_blank" rel="noopener noreferrer" class="agy-injected-btn agy-injected-btn-sidecars" title="Open Sidecar Manager in a new tab">
                \${SIDECAR_ICON_SVG}
                <span class="agy-injected-btn-text">Sidecar Manager</span>
                \${EXTERNAL_ICON_SVG}
            </a>`;

    const ideButtonHtml = ENABLE_IDE ? `
            <a href="/ide/" target="_blank" rel="noopener noreferrer" class="agy-injected-btn agy-injected-btn-ide" title="Open VS Code Web IDE in a new tab">
                \${IDE_ICON_SVG}
                <span class="agy-injected-btn-text">Web IDE</span>
                \${EXTERNAL_ICON_SVG}
            </a>` : '';

    const termButtonHtml = ENABLE_TERMINAL ? `
            <a href="/terminal/" target="_blank" rel="noopener noreferrer" class="agy-injected-btn agy-injected-btn-terminal" title="Open Host Terminal in a new tab">
                \${TERMINAL_ICON_SVG}
                <span class="agy-injected-btn-text">Host Terminal</span>
                \${EXTERNAL_ICON_SVG}
            </a>` : '';

    return `
(function initAntigravityCustomTools() {
    const SIDECAR_ICON_SVG = '<svg class="agy-injected-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>';
    const IDE_ICON_SVG = '<svg class="agy-injected-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>';
    const TERMINAL_ICON_SVG = '<svg class="agy-injected-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>';
    const EXTERNAL_ICON_SVG = '<svg class="agy-injected-external-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>';

    function createToolsElement() {
        const container = document.createElement('div');
        container.id = 'agy-injected-tools-group';
        container.className = 'agy-injected-tools-group';
        container.innerHTML = \`<div class="agy-injected-tools-label">Workspace Tools</div>${sidecarButtonHtml}${ideButtonHtml}${termButtonHtml}\`;
        return container;
    }

    function tryInjectSidebar() {
        if (document.getElementById('agy-injected-tools-group')) return;

        const allElements = document.querySelectorAll('button, a, div[role="button"], li, nav, aside');
        let targetElement = null;

        for (const el of allElements) {
            const text = (el.textContent || '').trim().toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            const title = (el.getAttribute('title') || '').toLowerCase();
            if (
                text.includes('conversation history') ||
                text.includes('history') ||
                aria.includes('history') ||
                title.includes('history') ||
                text.includes('new conversation') ||
                aria.includes('new conversation')
            ) {
                targetElement = el;
                if (text.includes('history') || aria.includes('history')) {
                    break;
                }
            }
        }

        if (targetElement) {
            const parent = targetElement.closest('ul, ol, nav, aside, div[class*="sidebar"], div[class*="nav"]') || targetElement.parentElement;
            if (parent) {
                const toolsEl = createToolsElement();
                if (targetElement.nextSibling) {
                    targetElement.parentNode.insertBefore(toolsEl, targetElement.nextSibling);
                } else {
                    targetElement.parentNode.appendChild(toolsEl);
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
        if (!document.getElementById('agy-injected-tools-group')) {
            tryInjectSidebar();
        }
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
    buildInjectedScript,
};
