'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FAVICON_SVG_CONTENT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="100%" height="100%" fill="none">
    <path d="M18 3L23.5 12.5H12.5L18 3Z" fill="url(#brand-grad)" />
    <path d="M18 12L27 27.5H9L18 12Z" fill="url(#brand-grad-2)" opacity="0.9" />
    <circle cx="18" cy="20" r="3.5" fill="#ffffff" />
    <defs>
        <linearGradient id="brand-grad" x1="12.5" y1="3" x2="23.5" y2="12.5" gradientUnits="userSpaceOnUse">
            <stop stop-color="#38bdf8" />
            <stop offset="1" stop-color="#1a73e8" />
        </linearGradient>
        <linearGradient id="brand-grad-2" x1="9" y1="12" x2="27" y2="27.5" gradientUnits="userSpaceOnUse">
            <stop stop-color="#4285f4" />
            <stop offset="1" stop-color="#a78bfa" />
        </linearGradient>
    </defs>
</svg>`;

const FAVICON_SVG_BUFFER = Buffer.from(FAVICON_SVG_CONTENT, 'utf8');
const assetCache = new Map();

function loadAsset(filename, fallbackBuffer = Buffer.alloc(0)) {
    const possiblePaths = [
        path.join(__dirname, '../../assets', filename),
        path.join(__dirname, '../assets', filename),
        path.join('/usr/local/share/antigravity/assets', filename),
        path.join('/workspace/antigravity-docker/assets', filename)
    ];
    for (const p of possiblePaths) {
        try {
            if (fs.existsSync(p)) {
                return fs.readFileSync(p);
            }
        } catch (e) {}
    }
    return fallbackBuffer;
}

function getCachedAsset(filename, defaultBuffer) {
    if (assetCache.has(filename)) return assetCache.get(filename);
    const buf = loadAsset(filename, defaultBuffer);
    if (buf && buf.length > 0) {
        assetCache.set(filename, buf);
        return buf;
    }
    return defaultBuffer;
}

const EXACT_FAVICON_PATHS = new Set([
    '/favicon.ico',
    '/favicon.svg',
    '/favicon.png',
    '/apple-touch-icon.png',
    '/apple-touch-icon-precomposed.png',
    '/terminal/favicon.ico',
    '/terminal/favicon.svg',
    '/terminal/favicon.png',
    '/terminal/apple-touch-icon.png',
    '/ide/favicon.ico',
    '/ide/favicon.svg',
    '/ide/favicon.png',
    '/ide/apple-touch-icon.png',
]);

function isFaviconRequest(pathname) {
    if (EXACT_FAVICON_PATHS.has(pathname)) return true;
    if (pathname.startsWith('/ide/_static/src/browser/media/favicon') ||
        pathname.startsWith('/ide/_static/src/browser/media/pwa-icon') ||
        pathname.endsWith('/workbench/browser/media/favicon.ico') ||
        pathname.endsWith('/resources/server/favicon.ico')) {
        return true;
    }
    return false;
}

function handleFaviconRequest(req, res, pathname) {
    let contentType = 'image/svg+xml; charset=utf-8';
    let data = FAVICON_SVG_BUFFER;

    if (pathname.endsWith('.svg')) {
        contentType = 'image/svg+xml; charset=utf-8';
        data = getCachedAsset('favicon.svg', FAVICON_SVG_BUFFER);
    } else if (pathname.endsWith('.ico')) {
        contentType = 'image/x-icon';
        data = getCachedAsset('favicon.ico', FAVICON_SVG_BUFFER);
    } else if (pathname.includes('512')) {
        contentType = 'image/png';
        const name = pathname.includes('maskable') ? 'pwa-icon-maskable-512.png' : 'pwa-icon-512.png';
        data = getCachedAsset(name, getCachedAsset('favicon.png', FAVICON_SVG_BUFFER));
    } else if (pathname.includes('192')) {
        contentType = 'image/png';
        const name = pathname.includes('maskable') ? 'pwa-icon-maskable-192.png' : 'pwa-icon-192.png';
        data = getCachedAsset(name, getCachedAsset('favicon.png', FAVICON_SVG_BUFFER));
    } else if (pathname.includes('apple-touch-icon')) {
        contentType = 'image/png';
        data = getCachedAsset('apple-touch-icon.png', getCachedAsset('favicon.png', FAVICON_SVG_BUFFER));
    } else if (pathname.endsWith('.png')) {
        contentType = 'image/png';
        data = getCachedAsset('favicon.png', FAVICON_SVG_BUFFER);
    }

    res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': data.length,
        'Cache-Control': 'public, max-age=86400, must-revalidate',
        'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
}

// Helper to strip existing favicon/touch-icon links and inject unified Antigravity favicon links
function replaceFaviconInHtml(html) {
    const cleaned = html.replace(/<link\b(?:"[^"]*"|'[^']*'|[^'">])*?>/gis, (tag) => {
        if (/rel\s*=\s*["'](?:shortcut |alternate )?icon["']/i.test(tag) ||
            /rel\s*=\s*["']apple-touch-icon(?:-precomposed)?["']/i.test(tag)) {
            return '';
        }
        return tag;
    });

    const faviconTags = '<link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="alternate icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple-touch-icon.png">';
    if (cleaned.includes('</head>')) {
        return cleaned.replace('</head>', `${faviconTags}</head>`);
    } else if (cleaned.includes('<head>')) {
        return cleaned.replace('<head>', `<head>${faviconTags}`);
    }
    return `${faviconTags}${cleaned}`;
}

module.exports = {
    FAVICON_SVG_CONTENT,
    FAVICON_SVG_BUFFER,
    isFaviconRequest,
    handleFaviconRequest,
    replaceFaviconInHtml,
};
