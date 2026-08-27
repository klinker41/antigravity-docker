#!/usr/bin/env node

const http = require('node:http');
const crypto = require('node:crypto');
const url = require('node:url');
const fs = require('node:fs');
const path = require('node:path');

let sidecarManager;
try {
    sidecarManager = require('./sidecar-manager.js');
} catch (e) {
    try {
        sidecarManager = require('/usr/local/bin/sidecar-manager.js');
    } catch (err) {
        console.error('[Proxy Gateway] Warning: sidecar-manager module could not be loaded:', err.message);
    }
}

function isFeatureEnabled(val, defaultVal = true) {
    if (val === undefined || val === null || val === '') return defaultVal;
    const s = String(val).trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

const LISTEN_PORT = parseInt(process.env.AGY_PORT || '4400', 10);
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const PORT_FILE = process.env.PORT_FILE || '/tmp/antigravity_port';
const INSTANCE_NAME = process.env.RC_NAME || 'server-agent';
let TARGET_PORT = parseInt(process.env.INITIAL_TARGET_PORT || '0', 10);
const TERMINAL_PORT = parseInt(process.env.TERMINAL_PORT || '7681', 10);
const IDE_PORT = parseInt(process.env.IDE_PORT || '8080', 10);

const ENABLE_IDE = isFeatureEnabled(process.env.ENABLE_IDE, true);
const ENABLE_TERMINAL = isFeatureEnabled(process.env.ENABLE_TERMINAL, true);
const TRUST_PROXY = isFeatureEnabled(process.env.TRUST_PROXY, false);

// In-Memory Session Store: Map<sessionToken, { createdAt: number, expiresAt: number }>
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const activeSessions = new Map();

// Rate Limiter Store for login attempts: Map<ip, { attempts: number, resetTime: number, lockUntil: number }>
const loginRateLimiter = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// Clean up expired sessions and rate limits periodically
setInterval(() => {
    const now = Date.now();
    for (const [token, session] of activeSessions.entries()) {
        if (session.expiresAt <= now) activeSessions.delete(token);
    }
    for (const [ip, record] of loginRateLimiter.entries()) {
        if (record.resetTime <= now && record.lockUntil <= now) loginRateLimiter.delete(ip);
    }
}, 60 * 1000);

// Constant-time string comparison using SHA-256 digests to prevent timing attacks
function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const hashA = crypto.createHash('sha256').update(a).digest();
    const hashB = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(hashA, hashB);
}

// Extract client IP address (only trust reverse proxy X-Forwarded-For if TRUST_PROXY is enabled)
function getClientIp(req) {
    const remote = req.socket?.remoteAddress || '127.0.0.1';
    if (TRUST_PROXY && req.headers['x-forwarded-for']) {
        const forwarded = req.headers['x-forwarded-for'];
        return forwarded.split(',')[0].trim();
    }
    return remote;
}

// Check rate limit status for login
function checkRateLimit(ip) {
    const now = Date.now();
    let record = loginRateLimiter.get(ip);
    if (!record) {
        record = { attempts: 0, resetTime: now + RATE_LIMIT_WINDOW_MS, lockUntil: 0 };
        loginRateLimiter.set(ip, record);
    }
    if (record.lockUntil > now) {
        const remainingSeconds = Math.ceil((record.lockUntil - now) / 1000);
        return { allowed: false, message: `Too many failed attempts. Locked out for ${remainingSeconds} seconds.` };
    }
    if (record.resetTime <= now) {
        record.attempts = 0;
        record.resetTime = now + RATE_LIMIT_WINDOW_MS;
    }
    return { allowed: true, record };
}

// Record a failed login attempt
function recordFailedAttempt(ip) {
    const record = loginRateLimiter.get(ip);
    if (record) {
        record.attempts += 1;
        if (record.attempts >= MAX_LOGIN_ATTEMPTS) {
            record.lockUntil = Date.now() + LOCKOUT_DURATION_MS;
        }
    }
}

// Parse cookies helper
function parseCookies(req) {
    const list = {};
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return list;

    cookieHeader.split(';').forEach(cookie => {
        let [name, ...rest] = cookie.split('=');
        name = name?.trim();
        if (!name) return;
        const value = rest.join('=').trim();
        list[name] = decodeURIComponent(value);
    });
    return list;
}

// Check if request is authenticated
function isAuthenticated(req) {
    if (!AUTH_PASSWORD) return true; // No password configured -> open access
    const cookies = parseCookies(req);
    const token = cookies['antigravity_session'];
    if (!token) return false;

    const session = activeSessions.get(token);
    if (!session) return false;
    if (session.expiresAt <= Date.now()) {
        activeSessions.delete(token);
        return false;
    }
    return true;
}

// Standard HTTP Security Headers
function applySecurityHeaders(res, req) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' ws: wss:; frame-ancestors 'self';");
    res.setHeader('X-Accel-Buffering', 'no');
    const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
    if (isHttps) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
}

// Read and parse JSON body helper
function readJsonBody(req, maxBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
        let body = '';
        let exceeded = false;
        req.on('data', chunk => {
            if (exceeded) return;
            body += chunk.toString();
            if (Buffer.byteLength(body, 'utf8') > maxBytes) {
                exceeded = true;
                reject(new Error('Payload Too Large'));
            }
        });
        req.on('end', () => {
            if (exceeded) return;
            try {
                const parsed = body ? JSON.parse(body) : {};
                resolve(parsed);
            } catch (err) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

// Shared Google Antigravity Vector Logo SVG
const ANTIGRAVITY_LOGO_SVG = `<svg class="logo-svg" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
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

// Shared Base CSS for all Antigravity Gateway pages (Login, Status, Sidecars, Modals, Logs)
const BASE_PAGE_CSS = `
:root {
    --bg-primary: #08090d;
    --card-bg: rgba(14, 18, 27, 0.75);
    --card-border: rgba(255, 255, 255, 0.1);
    --card-border-glow: rgba(66, 133, 244, 0.3);
    --accent-blue: #1a73e8;
    --accent-blue-hover: #1557b0;
    --accent-blue-glow: #4285f4;
    --accent-cyan: #38bdf8;
    --accent-purple: #a78bfa;
    --text-primary: #f0f4fc;
    --text-secondary: #94a3b8;
    --text-muted: #64748b;
    --input-bg: rgba(9, 12, 18, 0.7);
    --input-border: rgba(255, 255, 255, 0.12);
    --error-bg: rgba(239, 68, 68, 0.12);
    --error-border: rgba(239, 68, 68, 0.35);
    --error-text: #fca5a5;
    --success-bg: rgba(34, 197, 94, 0.1);
    --success-border: rgba(34, 197, 94, 0.25);
    --success-text: #86efac;
    --warning-bg: rgba(234, 179, 8, 0.1);
    --warning-border: rgba(234, 179, 8, 0.25);
    --warning-text: #fde047;
}

* {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    font-family: "Google Sans Flex", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

body {
    background-color: var(--bg-primary);
    color: var(--text-primary);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow-x: hidden;
    position: relative;
    padding: 24px 20px;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
}

.ambient-glow {
    position: fixed;
    border-radius: 50%;
    filter: blur(120px);
    pointer-events: none;
    opacity: 0.55;
    z-index: 1;
    animation: pulseGlow 14s ease-in-out infinite alternate;
}

.ambient-glow-1 {
    width: 500px;
    height: 500px;
    background: radial-gradient(circle, rgba(26, 115, 232, 0.35) 0%, rgba(26, 115, 232, 0) 70%);
    top: -100px;
    left: -100px;
}

.ambient-glow-2 {
    width: 550px;
    height: 550px;
    background: radial-gradient(circle, rgba(124, 58, 237, 0.28) 0%, rgba(124, 58, 237, 0) 70%);
    bottom: -120px;
    right: -120px;
    animation-duration: 18s;
}

.ambient-glow-3 {
    width: 380px;
    height: 380px;
    background: radial-gradient(circle, rgba(56, 189, 248, 0.22) 0%, rgba(56, 189, 248, 0) 70%);
    top: 45%;
    left: 60%;
    animation-duration: 12s;
}

@keyframes pulseGlow {
    0% { transform: scale(1) translate(0, 0); opacity: 0.45; }
    50% { transform: scale(1.15) translate(20px, -20px); opacity: 0.65; }
    100% { transform: scale(0.95) translate(-15px, 15px); opacity: 0.5; }
}

#antigravity-canvas {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 2;
    pointer-events: auto;
}

.page-wrapper {
    position: relative;
    z-index: 10;
    width: 100%;
    max-width: 420px;
    margin: auto;
}

.page-card {
    background: var(--card-bg);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid var(--card-border);
    border-radius: 20px;
    padding: 36px 32px;
    box-shadow:
        0 30px 70px rgba(0, 0, 0, 0.7),
        0 0 45px rgba(26, 115, 232, 0.12),
        inset 0 1px 0 rgba(255, 255, 255, 0.15);
    transition: border-color 0.3s ease, box-shadow 0.3s ease;
    text-align: center;
}

.page-card:hover {
    border-color: var(--card-border-glow);
    box-shadow:
        0 35px 80px rgba(0, 0, 0, 0.75),
        0 0 55px rgba(66, 133, 244, 0.18),
        inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.brand-header {
    text-align: center;
    margin-bottom: 24px;
}

.status-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 500;
    margin-bottom: 16px;
    letter-spacing: 0.3px;
    text-transform: uppercase;
}

.status-pill-success {
    background: var(--success-bg);
    border: 1px solid var(--success-border);
    color: var(--success-text);
}

.status-pill-error {
    background: var(--error-bg);
    border: 1px solid var(--error-border);
    color: var(--error-text);
}

.status-pill-warning {
    background: var(--warning-bg);
    border: 1px solid var(--warning-border);
    color: var(--warning-text);
}

.status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
}

.status-dot-success {
    background-color: #22c55e;
    box-shadow: 0 0 8px #22c55e;
    animation: statusBlink 2s infinite;
}

.status-dot-error {
    background-color: #ef4444;
    box-shadow: 0 0 8px #ef4444;
    animation: statusBlink 1.2s infinite;
}

.status-dot-warning {
    background-color: #eab308;
    box-shadow: 0 0 8px #eab308;
    animation: statusBlink 1.5s infinite;
}

@keyframes statusBlink {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.85); }
}

.logo-container {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 60px;
    height: 60px;
    background: linear-gradient(135deg, rgba(26, 115, 232, 0.2), rgba(56, 189, 248, 0.1));
    border: 1px solid rgba(66, 133, 244, 0.35);
    border-radius: 16px;
    margin-bottom: 16px;
    box-shadow: 0 8px 24px rgba(26, 115, 232, 0.25);
    position: relative;
    overflow: hidden;
}

.logo-container::after {
    content: '';
    position: absolute;
    top: -50%;
    left: -50%;
    width: 200%;
    height: 200%;
    background: linear-gradient(60deg, transparent, rgba(255, 255, 255, 0.15), transparent);
    transform: rotate(30deg);
    animation: logoShine 6s infinite ease-in-out;
}

@keyframes logoShine {
    0%, 75% { transform: rotate(30deg) translateY(-100%); }
    100% { transform: rotate(30deg) translateY(100%); }
}

.logo-svg {
    width: 32px;
    height: 32px;
    filter: drop-shadow(0 2px 8px rgba(66, 133, 244, 0.5));
}

h1 {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.3px;
    color: #ffffff;
    margin-bottom: 6px;
}

p.subtitle {
    font-size: 13.5px;
    color: var(--text-secondary);
    line-height: 1.4;
}

.error-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--error-bg);
    border: 1px solid var(--error-border);
    color: var(--error-text);
    padding: 11px 14px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 20px;
    animation: shake 0.45s ease-in-out;
    text-align: left;
}

@keyframes shake {
    0%, 100% { transform: translateX(0); }
    20%, 60% { transform: translateX(-6px); }
    40%, 80% { transform: translateX(6px); }
}

.error-icon {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
}

.form-group {
    margin-bottom: 22px;
    text-align: left;
}

.label-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
}

label {
    font-size: 13px;
    font-weight: 500;
    color: #cbd5e1;
    letter-spacing: 0.1px;
}

.input-container {
    position: relative;
    display: flex;
    align-items: center;
}

.input-icon {
    position: absolute;
    left: 14px;
    width: 17px;
    height: 17px;
    color: var(--text-muted);
    pointer-events: none;
    transition: color 0.2s ease;
}

input[type="password"],
input[type="text"],
input[type="number"],
select,
textarea {
    width: 100%;
    padding: 12px 14px;
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    border-radius: 10px;
    color: #ffffff;
    font-size: 13.5px;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
    font-family: inherit;
}

input[type="password"],
input.with-left-icon {
    padding-left: 40px;
}

textarea {
    resize: vertical;
    min-height: 80px;
    line-height: 1.45;
}

select {
    appearance: none;
    background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%2394a3b8'%3e%3cpath d='M7 10l5 5 5-5z'/%3e%3c/svg%3e");
    background-repeat: no-repeat;
    background-position: right 12px center;
    background-size: 18px;
    padding-right: 36px;
    cursor: pointer;
}

select option {
    background-color: #0b0e14;
    color: #ffffff;
}

input:focus,
select:focus,
textarea:focus {
    background: rgba(12, 16, 25, 0.95);
    border-color: var(--accent-blue-glow);
    box-shadow:
        0 0 0 3px rgba(66, 133, 244, 0.25),
        0 0 16px rgba(66, 133, 244, 0.15);
}

.toggle-password {
    position: absolute;
    right: 12px;
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    transition: color 0.2s, background-color 0.2s;
}

.toggle-password:hover {
    color: var(--text-primary);
    background: rgba(255, 255, 255, 0.06);
}

button[type="submit"],
.btn-primary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 11px 18px;
    background: linear-gradient(135deg, #1a73e8 0%, #3b82f6 100%);
    color: #ffffff;
    text-decoration: none;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 10px;
    font-size: 13.5px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 18px rgba(26, 115, 232, 0.35);
    transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

button[type="submit"]:hover,
.btn-primary:hover {
    background: linear-gradient(135deg, #1967d2 0%, #2563eb 100%);
    box-shadow: 0 6px 24px rgba(26, 115, 232, 0.5);
    transform: translateY(-1.5px);
}

.btn-secondary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 14px;
    background: rgba(255, 255, 255, 0.05);
    color: var(--text-secondary);
    text-decoration: none;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
}

.btn-secondary:hover {
    background: rgba(255, 255, 255, 0.1);
    color: var(--text-primary);
    border-color: rgba(255, 255, 255, 0.2);
}

.btn-danger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 12px;
    background: rgba(239, 68, 68, 0.12);
    color: #fca5a5;
    text-decoration: none;
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 8px;
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
}

.btn-danger:hover {
    background: rgba(239, 68, 68, 0.25);
    border-color: rgba(239, 68, 68, 0.5);
    color: #ffffff;
}

.btn-icon {
    width: 16px;
    height: 16px;
    transition: transform 0.2s ease;
}

.action-row {
    display: flex;
    gap: 10px;
    align-items: center;
}

.status-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    margin-bottom: 24px;
    background: rgba(9, 12, 18, 0.55);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px;
    padding: 16px;
}

.grid-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
    text-align: left;
}

.grid-label {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.grid-value {
    font-size: 13.5px;
    color: var(--text-primary);
    font-weight: 500;
    word-break: break-all;
}

.grid-value code {
    font-family: "Google Sans Code", monospace;
    font-size: 12px;
    color: #cbd5e1;
    background: rgba(255, 255, 255, 0.05);
    padding: 1px 4px;
    border-radius: 4px;
}

.val-success { color: #4ade80; font-weight: 600; }
.val-error { color: #f87171; font-weight: 600; }

.spinner {
    width: 48px;
    height: 48px;
    border: 3px solid rgba(66, 133, 244, 0.2);
    border-top: 3px solid #38bdf8;
    border-right: 3px solid #1a73e8;
    border-radius: 50%;
    margin: 0 auto 24px;
    animation: spin 1s linear infinite;
}

@keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}

.card-footer {
    margin-top: 24px;
    text-align: center;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    padding-top: 18px;
}

.card-footer p {
    font-size: 12px;
    color: var(--text-muted);
    letter-spacing: 0.2px;
}

.card-footer code {
    font-family: "Google Sans Code", monospace;
    background: rgba(255, 255, 255, 0.05);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
    color: #cbd5e1;
}

.json-link {
    color: var(--accent-cyan);
    text-decoration: none;
    transition: opacity 0.2s ease;
}

.json-link:hover {
    text-decoration: underline;
}

.auto-refresh-badge {
    margin-top: 12px;
    font-size: 11.5px;
    color: var(--text-muted);
}

/* Reusable Toolbar */
.top-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 24px;
    gap: 12px;
    flex-wrap: wrap;
}
.toolbar-group {
    display: flex;
    align-items: center;
    gap: 8px;
}

/* Reusable Content List and Cards */
.content-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
    text-align: left;
    margin-bottom: 24px;
}
.content-card {
    background: rgba(9, 12, 18, 0.65);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px;
    padding: 20px;
    transition: all 0.25s ease;
    position: relative;
}
.content-card:hover {
    border-color: rgba(66, 133, 244, 0.3);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
}
.card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
}
.card-title-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
}
.card-title {
    font-size: 16px;
    font-weight: 600;
    color: #ffffff;
}
.card-id-code {
    font-family: "Google Sans Code", monospace;
    font-size: 11.5px;
    color: var(--text-muted);
    background: rgba(255, 255, 255, 0.05);
    padding: 2px 6px;
    border-radius: 4px;
}
.card-desc {
    font-size: 13.5px;
    color: var(--text-secondary);
    margin-bottom: 14px;
    line-height: 1.45;
}
.card-chips {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 16px;
}
.card-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    padding-top: 14px;
    gap: 10px;
    flex-wrap: wrap;
}
.actions-left, .actions-right {
    display: flex;
    align-items: center;
    gap: 8px;
}

/* Reusable Chips & Badges */
.chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 9px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    font-size: 12px;
    color: #cbd5e1;
}
.chip code {
    font-family: "Google Sans Code", monospace;
    font-size: 11px;
    color: #38bdf8;
}
.chip-cyan { border-color: rgba(56, 189, 248, 0.3); background: rgba(56, 189, 248, 0.08); color: #38bdf8; }
.chip-purple { border-color: rgba(167, 139, 250, 0.3); background: rgba(167, 139, 250, 0.08); color: #c4b5fd; }
.chip-green { border-color: rgba(34, 197, 94, 0.3); background: rgba(34, 197, 94, 0.08); color: #86efac; }
.chip-muted { color: var(--text-muted); }

/* Reusable Toggle Switch */
.switch {
    position: relative;
    display: inline-block;
    width: 44px;
    height: 24px;
}
.switch input { opacity: 0; width: 0; height: 0; }
.slider {
    position: absolute;
    cursor: pointer;
    top: 0; left: 0; right: 0; bottom: 0;
    background-color: rgba(255, 255, 255, 0.15);
    transition: .25s;
    border-radius: 24px;
}
.slider:before {
    position: absolute;
    content: "";
    height: 18px;
    width: 18px;
    left: 3px;
    bottom: 3px;
    background-color: white;
    transition: .25s;
    border-radius: 50%;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
}
input:checked + .slider {
    background-color: #22c55e;
    box-shadow: 0 0 10px rgba(34, 197, 94, 0.4);
}
input:checked + .slider:before {
    transform: translateX(20px);
}

/* Reusable Modals */
.modal-overlay {
    display: none;
    position: fixed;
    top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(8px);
    z-index: 1000;
    align-items: center;
    justify-content: center;
    padding: 20px;
}
.modal-overlay.active { display: flex; }
.modal-box {
    background: #0d111a;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 18px;
    width: 100%;
    max-width: 600px;
    max-height: 90vh;
    overflow-y: auto;
    padding: 28px;
    box-shadow: 0 25px 60px rgba(0, 0, 0, 0.8), 0 0 40px rgba(26, 115, 232, 0.15);
    text-align: left;
    animation: modalPop 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes modalPop {
    0% { transform: scale(0.95); opacity: 0; }
    100% { transform: scale(1); opacity: 1; }
}
.modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    padding-bottom: 14px;
}
.modal-header h2 { font-size: 18px; color: #ffffff; }
.modal-close {
    background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 4px; border-radius: 6px;
}
.modal-close:hover { color: #ffffff; background: rgba(255, 255, 255, 0.08); }

/* Reusable Tabs */
.tabs {
    display: flex;
    gap: 6px;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 10px;
    padding: 4px;
    margin-bottom: 20px;
}
.tab-btn {
    flex: 1;
    padding: 8px 12px;
    border-radius: 8px;
    border: none;
    background: none;
    color: var(--text-secondary);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    text-align: center;
}
.tab-btn.active {
    background: rgba(26, 115, 232, 0.3);
    color: #ffffff;
    font-weight: 600;
    border: 1px solid rgba(66, 133, 244, 0.4);
}
.tab-pane { display: none; }
.tab-pane.active { display: block; }

/* Reusable Code & Terminal Log Output Box */
.code-box, .log-box {
    background: #050608;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    padding: 14px;
    font-family: "Google Sans Code", monospace;
    font-size: 12px;
    color: #cbd5e1;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 400px;
    overflow-y: auto;
    margin-bottom: 20px;
    line-height: 1.5;
}

/* Reusable Toast Notifications */
.toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: rgba(14, 20, 30, 0.95);
    border: 1px solid rgba(66, 133, 244, 0.4);
    border-radius: 10px;
    padding: 12px 18px;
    color: #ffffff;
    font-size: 13.5px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
    z-index: 2000;
    transform: translateY(100px);
    opacity: 0;
    transition: all 0.3s ease;
    display: flex;
    align-items: center;
    gap: 10px;
}
.toast.show { transform: translateY(0); opacity: 1; }

/* Reusable Empty State */
.empty-state {
    padding: 48px 24px;
    text-align: center;
    border: 1px dashed rgba(255, 255, 255, 0.12);
    border-radius: 16px;
    margin-bottom: 24px;
}
.empty-state svg { width: 44px; height: 44px; color: var(--text-muted); margin-bottom: 12px; }
.empty-state p { color: var(--text-secondary); font-size: 14px; margin-bottom: 16px; }

@media (max-width: 600px) {
    .page-card { padding: 24px 16px; border-radius: 16px; }
    .status-grid { grid-template-columns: 1fr; }
    h1 { font-size: 20px; }
}
`;

// Shared Antigravity Particle Simulation Engine Script
const PARTICLE_SIMULATION_SCRIPT = `
(function initAntigravityBackground() {
    const canvas = document.getElementById('antigravity-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = window.devicePixelRatio || 1;
    let particles = [];
    let shockwaves = [];
    let animationFrameId = null;

    const mouse = { x: -1000, y: -1000, radius: 150, active: false };

    const colors = [
        'rgba(138, 180, 248, ',
        'rgba(66, 133, 244, ',
        'rgba(56, 189, 248, ',
        'rgba(167, 139, 250, ',
        'rgba(255, 255, 255, '
    ];

    function resize() {
        width = window.innerWidth;
        height = window.innerHeight;
        dpr = Math.min(window.devicePixelRatio || 1, 2);

        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.scale(dpr, dpr);

        initParticles();
    }

    class Particle {
        constructor() {
            this.reset(true);
        }

        reset(initial = false) {
            this.x = Math.random() * width;
            this.y = initial ? Math.random() * height : height + Math.random() * 20;
            this.baseVx = (Math.random() - 0.5) * 0.4;
            this.baseVy = -(Math.random() * 0.45 + 0.2);
            this.vx = this.baseVx;
            this.vy = this.baseVy;
            this.radius = Math.random() * 1.8 + 0.8;
            this.baseAlpha = Math.random() * 0.55 + 0.2;
            this.alpha = this.baseAlpha;
            this.colorBase = colors[Math.floor(Math.random() * colors.length)];
            this.pulseSpeed = Math.random() * 0.02 + 0.008;
            this.pulsePhase = Math.random() * Math.PI * 2;
        }

        update() {
            this.pulsePhase += this.pulseSpeed;
            this.alpha = this.baseAlpha + Math.sin(this.pulsePhase) * 0.15;

            if (mouse.active) {
                const dx = this.x - mouse.x;
                const dy = this.y - mouse.y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < mouse.radius && dist > 0) {
                    const force = (1 - dist / mouse.radius) * 1.6;
                    const angle = Math.atan2(dy, dx);
                    this.vx += Math.cos(angle) * force * 0.4;
                    this.vy += Math.sin(angle) * force * 0.4;
                }
            }

            for (const sw of shockwaves) {
                const dx = this.x - sw.x;
                const dy = this.y - sw.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const diff = Math.abs(dist - sw.radius);

                if (diff < 35 && dist > 0) {
                    const force = (1 - diff / 35) * sw.strength * 0.35;
                    const angle = Math.atan2(dy, dx);
                    this.vx += Math.cos(angle) * force;
                    this.vy += Math.sin(angle) * force;
                }
            }

            this.vx += (this.baseVx - this.vx) * 0.04;
            this.vy += (this.baseVy - this.vy) * 0.04;

            this.x += this.vx;
            this.y += this.vy;

            if (this.y < -20) this.reset(false);
            if (this.x < -20) this.x = width + 20;
            if (this.x > width + 20) this.x = -20;
        }

        draw() {
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
            ctx.fillStyle = this.colorBase + Math.max(0.05, Math.min(1, this.alpha)) + ')';
            ctx.fill();
        }
    }

    function initParticles() {
        const count = Math.min(95, Math.max(45, Math.floor((width * height) / 14000)));
        particles = [];
        for (let i = 0; i < count; i++) {
            particles.push(new Particle());
        }
    }

    window.addEventListener('mousemove', (e) => {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
        mouse.active = true;
    }, { passive: true });

    window.addEventListener('mouseleave', () => {
        mouse.active = false;
    });

    window.addEventListener('pointerdown', (e) => {
        shockwaves.push({
            x: e.clientX,
            y: e.clientY,
            radius: 5,
            maxRadius: 180,
            speed: 4.5,
            strength: 3.5,
            alpha: 0.6
        });
    });

    function render() {
        ctx.clearRect(0, 0, width, height);

        for (let i = shockwaves.length - 1; i >= 0; i--) {
            const sw = shockwaves[i];
            sw.radius += sw.speed;
            sw.alpha *= 0.94;

            ctx.beginPath();
            ctx.arc(sw.x, sw.y, sw.radius, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(138, 180, 248, ' + (sw.alpha * 0.35) + ')';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            if (sw.radius > sw.maxRadius || sw.alpha < 0.02) {
                shockwaves.splice(i, 1);
            }
        }

        const connectionDist = 110;
        for (let i = 0; i < particles.length; i++) {
            const p1 = particles[i];
            p1.update();
            p1.draw();

            for (let j = i + 1; j < particles.length; j++) {
                const p2 = particles[j];
                const dx = p1.x - p2.x;
                const dy = p1.y - p2.y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < connectionDist) {
                    const lineAlpha = (1 - dist / connectionDist) * 0.22 * Math.min(p1.alpha, p2.alpha);
                    ctx.beginPath();
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.strokeStyle = 'rgba(138, 180, 248, ' + lineAlpha + ')';
                    ctx.lineWidth = 0.8;
                    ctx.stroke();
                }
            }
        }

        animationFrameId = requestAnimationFrame(render);
    }

    window.addEventListener('resize', resize);
    resize();

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!prefersReducedMotion) {
        render();
    } else {
        particles.forEach(p => p.draw());
    }
})();
`;

// Shared Base HTML Page Layout Template
function renderPageLayout({
    title = 'Google Antigravity',
    headMeta = '',
    subtitle = '',
    statusPill = '',
    error = '',
    bodyHtml = '',
    footerExtra = '',
    scriptExtra = '',
    cardMaxWidth = 420
}) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${headMeta}
    <title>${title}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:wght@400;500;600;700&family=Google+Sans+Code:wght@400;500&display=swap" rel="stylesheet">
    <style>
        ${BASE_PAGE_CSS}
        .page-wrapper { max-width: ${cardMaxWidth}px; }
    </style>
</head>
<body>
    <div class="ambient-glow ambient-glow-1"></div>
    <div class="ambient-glow ambient-glow-2"></div>
    <div class="ambient-glow ambient-glow-3"></div>

    <canvas id="antigravity-canvas"></canvas>

    <div class="page-wrapper">
        <div class="page-card">
            <div class="brand-header">
                ${statusPill}
                <div>
                    <div class="logo-container">
                        ${ANTIGRAVITY_LOGO_SVG}
                    </div>
                </div>
                <h1>Google Antigravity</h1>
                ${subtitle ? `<p class="subtitle">${subtitle}</p>` : ''}
            </div>

            ${error ? `
            <div class="error-banner">
                <svg class="error-icon" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 1 1-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                </svg>
                <span>${error}</span>
            </div>` : ''}

            ${bodyHtml}

            <div class="card-footer">
                <p>Protected by <code>Antigravity Gateway</code> ${footerExtra}</p>
            </div>
        </div>
    </div>

    <script>
        ${PARTICLE_SIMULATION_SCRIPT}
        ${scriptExtra}
    </script>
</body>
</html>`;
}

// Modern Google Antigravity Dark Theme Login Page HTML
function renderLoginPage(error = '') {
    const statusPill = `
        <div class="status-pill status-pill-success">
            <span class="status-dot status-dot-success"></span>
            <span>Gateway Secured</span>
        </div>`;

    const bodyHtml = `
        <form method="POST" action="/__auth/login">
            <div class="form-group">
                <div class="label-row">
                    <label for="password">Password</label>
                </div>
                <div class="input-container">
                    <svg class="input-icon" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
                    </svg>
                    <input type="password" id="password" name="password" required autofocus placeholder="Enter access password..." autocomplete="current-password">
                    <button type="button" class="toggle-password" id="togglePasswordBtn" title="Toggle password visibility" aria-label="Toggle password visibility">
                        <svg id="eyeIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                            <circle cx="12" cy="12" r="3"></circle>
                        </svg>
                    </button>
                </div>
            </div>

            <button type="submit" id="submitBtn" style="width: 100%;">
                <span>Unlock Workspace</span>
                <svg class="btn-icon" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clip-rule="evenodd" />
                </svg>
            </button>
        </form>`;

    const scriptExtra = `
        const passwordInput = document.getElementById('password');
        const toggleBtn = document.getElementById('togglePasswordBtn');
        const eyeIcon = document.getElementById('eyeIcon');

        if (toggleBtn && passwordInput) {
            toggleBtn.addEventListener('click', () => {
                const isPassword = passwordInput.type === 'password';
                passwordInput.type = isPassword ? 'text' : 'password';
                eyeIcon.innerHTML = isPassword
                    ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>'
                    : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
            });
        }`;

    return renderPageLayout({
        title: 'Google Antigravity Remote Access',
        subtitle: 'Enter access password to unlock remote session',
        statusPill,
        error,
        bodyHtml,
        scriptExtra,
        cardMaxWidth: 420
    });
}

// Active upstream health check helper
function checkUpstreamHealth(port, timeoutMs = 2000) {
    return new Promise((resolve) => {
        if (!port) {
            return resolve({ up: false, error: 'Target port not discovered yet.' });
        }
        const startTime = Date.now();
        const req = http.request({
            hostname: '127.0.0.1',
            port: port,
            path: '/',
            method: 'GET',
            timeout: timeoutMs,
            headers: {
                'Host': `localhost:${port}`,
                'User-Agent': 'Antigravity-Status-Check'
            }
        }, (res) => {
            const latency = Date.now() - startTime;
            resolve({
                up: res.statusCode < 500,
                statusCode: res.statusCode,
                latency
            });
            res.resume();
        });

        req.on('timeout', () => {
            req.destroy(new Error(`Health check timed out after ${timeoutMs}ms`));
        });

        req.on('error', (err) => {
            resolve({
                up: false,
                error: err.code === 'ECONNREFUSED'
                    ? `Connection refused: Service is not responding on port ${port}`
                    : err.message
            });
        });

        req.end();
    });
}

// Modern Google Antigravity Dark Theme Status Page HTML
function renderStatusPage(health) {
    const isUp = Boolean(health && health.up);

    const statusPill = `
        <div class="status-pill ${isUp ? 'status-pill-success' : 'status-pill-error'}">
            <span class="status-dot ${isUp ? 'status-dot-success' : 'status-dot-error'}"></span>
            <span>${isUp ? 'Operational &bull; 200 OK' : 'Service Unavailable &bull; 503'}</span>
        </div>`;

    const bodyHtml = `
        <div class="status-grid" style="grid-template-columns: 1fr; margin-bottom: 24px;">
            <div class="grid-item" style="text-align: center; align-items: center;">
                <div class="grid-label">Status</div>
                <div class="grid-value ${isUp ? 'val-success' : 'val-error'}" style="font-size: 16px; margin-top: 4px;">
                    ${isUp ? 'OK' : 'OFFLINE'}
                </div>
            </div>
        </div>

        <div class="action-row" style="justify-content: center; flex-wrap: wrap;">
            ${isUp ? `
            <a href="/?useWebSocket=true" class="btn-primary">
                <span>Open Workspace</span>
                <svg class="btn-icon" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clip-rule="evenodd" />
                </svg>
            </a>
            <a href="/status" class="btn-secondary" title="Refresh health status">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="23 4 23 10 17 10"></polyline>
                    <polyline points="1 20 1 14 7 14"></polyline>
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                </svg>
                <span>Refresh</span>
            </a>
            ` : `
            <a href="/status" class="btn-primary">
                <svg class="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="23 4 23 10 17 10"></polyline>
                    <polyline points="1 20 1 14 7 14"></polyline>
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                </svg>
                <span>Retry Status</span>
            </a>
            `}
        </div>

        ${!isUp ? '<div class="auto-refresh-badge">Auto-refreshing status every 5 seconds</div>' : ''}`;

    return renderPageLayout({
        title: 'Google Antigravity - Status',
        headMeta: !isUp ? '<meta http-equiv="refresh" content="5">' : '',
        subtitle: isUp ? 'Antigravity instance is operational and healthy.' : 'Antigravity instance is currently unavailable.',
        statusPill,
        bodyHtml,
        footerExtra: '&bull; <a href="/status?format=json" class="json-link">JSON Format</a>',
        cardMaxWidth: 420
    });
}

// Modern 503 Starting Up Page HTML for Antigravity Core
function renderStartingPage() {
    const statusPill = `
        <div class="status-pill status-pill-warning">
            <span class="status-dot status-dot-warning"></span>
            <span>Initializing</span>
        </div>`;

    const bodyHtml = `
        <div class="spinner"></div>
        <p style="margin-bottom: 8px;">Initializing agent workspace and secure remote control tunnels. This page will automatically refresh.</p>
        <div class="auto-refresh-badge">Auto-refreshing every 3 seconds</div>`;

    return renderPageLayout({
        title: 'Starting Google Antigravity...',
        headMeta: '<meta http-equiv="refresh" content="3">',
        subtitle: 'Launching agent environment',
        statusPill,
        bodyHtml,
        cardMaxWidth: 440
    });
}

// Modern 503 Starting Up Page HTML for Sub-services (IDE / Terminal)
function renderServiceStartingPage(serviceName) {
    const statusPill = `
        <div class="status-pill status-pill-warning">
            <span class="status-dot status-dot-warning"></span>
            <span>Initializing ${serviceName}</span>
        </div>`;

    const bodyHtml = `
        <div class="spinner"></div>
        <p style="margin-bottom: 8px;">Starting <strong>${serviceName}</strong> service in the background. This page will automatically refresh.</p>
        <div class="auto-refresh-badge">Auto-refreshing every 2 seconds</div>`;

    return renderPageLayout({
        title: `Starting ${serviceName}...`,
        headMeta: '<meta http-equiv="refresh" content="2">',
        subtitle: `Launching ${serviceName}`,
        statusPill,
        bodyHtml,
        cardMaxWidth: 440
    });
}

// Modern Google Antigravity Sidecar Manager UI HTML
function renderSidecarsPage() {
    const statusPill = `
        <div class="status-pill status-pill-success">
            <span class="status-dot status-dot-success"></span>
            <span id="subsystem-pill">Sidecar Subsystem Active</span>
        </div>`;

    const bodyHtml = `
        <div class="top-toolbar">
            <div class="toolbar-group">
                <a href="/?useWebSocket=true" class="btn-secondary">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline>
                    </svg>
                    <span>Workspace</span>
                </a>
                <a href="/status" class="btn-secondary" title="View Service Health">
                    <span>Status</span>
                </a>
                <button type="button" class="btn-secondary" id="refreshBtn" title="Refresh list">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                    </svg>
                    <span>Refresh</span>
                </button>
            </div>
            <button type="button" class="btn-primary" id="openNewSidecarModalBtn">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                <span>New Sidecar</span>
            </button>
        </div>

        <div id="sidecars-list-container" class="content-list">
            <div style="text-align: center; padding: 32px;"><div class="spinner" style="width: 32px; height: 32px;"></div>Loading sidecars...</div>
        </div>

        <!-- Create / Edit Sidecar Modal -->
        <div id="sidecarModal" class="modal-overlay">
            <div class="modal-box">
                <div class="modal-header">
                    <h2 id="modalTitle">Define New Sidecar</h2>
                    <button type="button" class="modal-close" id="closeModalBtn">&times;</button>
                </div>

                <div class="tabs">
                    <button type="button" class="tab-btn active" data-tab="promptTab">🤖 Scheduled Prompt</button>
                    <button type="button" class="tab-btn" data-tab="commandTab">⏰ Scheduled Command</button>
                    <button type="button" class="tab-btn" data-tab="workerTab">⚙️ Background Worker</button>
                </div>

                <form id="sidecarForm">
                    <input type="hidden" id="formMode" value="create">

                    <div class="form-group" style="margin-bottom: 16px;">
                        <label for="sidecarId">Sidecar ID (Unique Name)</label>
                        <input type="text" id="sidecarId" required placeholder="e.g. pr-triage, daily-summary" pattern="[a-zA-Z0-9_\-\/]+" title="Alphanumeric, dashes, hyphens, slashes only">
                    </div>

                    <div class="form-group" style="margin-bottom: 16px;">
                        <label for="sidecarDisplayName">Display Name (Optional)</label>
                        <input type="text" id="sidecarDisplayName" placeholder="e.g. PR Triage Assistant">
                    </div>

                    <div class="form-group" style="margin-bottom: 16px;">
                        <label for="sidecarDescription">Description (Optional)</label>
                        <input type="text" id="sidecarDescription" placeholder="e.g. Runs hourly to summarize incoming pull requests">
                    </div>

                    <!-- TAB 1: Scheduled Agent Prompt -->
                    <div id="promptTab" class="tab-pane active">
                        <div class="form-group" style="margin-bottom: 16px;">
                            <label for="promptPreset">Schedule Preset</label>
                            <select id="promptPreset">
                                <option value="0 * * * *">Every Hour (0 * * * *)</option>
                                <option value="*/30 * * * *">Every 30 Minutes (*/30 * * * *)</option>
                                <option value="*/15 * * * *">Every 15 Minutes (*/15 * * * *)</option>
                                <option value="0 */6 * * *">Every 6 Hours (0 */6 * * *)</option>
                                <option value="0 9 * * *">Daily at 9:00 AM (0 9 * * *)</option>
                                <option value="custom">Custom Cron Expression...</option>
                            </select>
                        </div>

                        <div class="form-group" id="customPromptCronGroup" style="display: none; margin-bottom: 16px;">
                            <label for="promptCronExpr">Cron Expression (5-field)</label>
                            <input type="text" id="promptCronExpr" value="0 * * * *" placeholder="* * * * *">
                        </div>

                        <div class="form-group" style="margin-bottom: 16px;">
                            <label for="promptProject">Target Project</label>
                            <select id="promptProject">
                                <option value="outside-of-project">Outside of Project</option>
                            </select>
                        </div>

                        <div class="form-group" style="margin-bottom: 16px;">
                            <label for="promptModel">Model Tier</label>
                            <select id="promptModel">
                                <option value="inherit">Default (inherit)</option>
                                <option value="flash">Gemini Flash (fast)</option>
                                <option value="pro">Gemini Pro (deep reasoning)</option>
                                <option value="flash_lite">Gemini Flash Lite</option>
                            </select>
                        </div>

                        <div class="form-group" style="margin-bottom: 16px;">
                            <label for="promptContent">Agent Prompt / Task Instructions</label>
                            <textarea id="promptContent" placeholder="e.g. Give me a summary of incoming review requests and test failures." rows="3"></textarea>
                        </div>
                    </div>

                    <!-- TAB 2: Scheduled Custom Command -->
                    <div id="commandTab" class="tab-pane">
                        <div class="form-group" style="margin-bottom: 16px;">
                            <label for="commandCronExpr">Cron Expression (5-field)</label>
                            <input type="text" id="commandCronExpr" value="*/15 * * * *" placeholder="*/15 * * * *">
                        </div>

                        <div class="form-group" style="margin-bottom: 16px;">
                            <label for="commandExec">Command / Executable</label>
                            <input type="text" id="commandExec" placeholder="e.g. /bin/bash, python3, node">
                        </div>

                        <div class="form-group" style="margin-bottom: 16px;">
                            <label for="commandArgs">Arguments (One per line)</label>
                            <textarea id="commandArgs" placeholder="-c&#10;echo 'Scheduled task run'" rows="2"></textarea>
                        </div>
                    </div>

                    <!-- TAB 3: Continuous Background Worker -->
                    <div id="workerTab" class="tab-pane">
                        <div class="form-group" style="margin-bottom: 16px;">
                            <label for="workerCommand">Worker Executable</label>
                            <input type="text" id="workerCommand" placeholder="e.g. python3, node, /bin/bash">
                        </div>

                        <div class="form-group" style="margin-bottom: 16px;">
                            <label for="workerArgs">Worker Arguments (One per line)</label>
                            <textarea id="workerArgs" placeholder="worker.py&#10;--verbose" rows="2"></textarea>
                        </div>

                        <div class="form-group" style="margin-bottom: 16px;">
                            <label for="workerRestartPolicy">Restart Policy</label>
                            <select id="workerRestartPolicy">
                                <option value="always" selected>always (Restart immediately upon exit)</option>
                                <option value="on-failure">on-failure (Restart only if exited with error)</option>
                                <option value="never">never (Do not restart)</option>
                            </select>
                        </div>
                    </div>

                    <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 24px; padding-top: 16px; border-top: 1px solid rgba(255, 255, 255, 0.08);">
                        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                            <input type="checkbox" id="sidecarEnabled" checked style="width: 18px; height: 18px; accent-color: #1a73e8;">
                            <span style="font-size: 13.5px;">Enable sidecar immediately</span>
                        </label>
                        <div style="display: flex; gap: 10px;">
                            <button type="button" class="btn-secondary" id="cancelModalBtn">Cancel</button>
                            <button type="submit" class="btn-primary" id="saveSidecarBtn">Save Sidecar</button>
                        </div>
                    </div>
                </form>
            </div>
        </div>

        <!-- Log Viewer Modal -->
        <div id="logModal" class="modal-overlay">
            <div class="modal-box" style="max-width: 720px;">
                <div class="modal-header">
                    <h2 id="logModalTitle">Sidecar Logs</h2>
                    <button type="button" class="modal-close" id="closeLogModalBtn">&times;</button>
                </div>
                <div id="logContent" class="log-box">Loading logs...</div>
                <div style="display: flex; justify-content: flex-end; gap: 10px;">
                    <button type="button" class="btn-secondary" id="refreshLogBtn">Refresh</button>
                    <button type="button" class="btn-primary" id="doneLogModalBtn">Close</button>
                </div>
            </div>
        </div>

        <div id="toast" class="toast">
            <span id="toastMessage">Success</span>
        </div>
    `;

    const scriptExtra = `
        let sidecarsData = [];
        let projectsData = [];
        let activeTab = 'promptTab';
        let currentLogSidecarId = null;

        const listContainer = document.getElementById('sidecars-list-container');
        const modal = document.getElementById('sidecarModal');
        const logModal = document.getElementById('logModal');
        const sidecarForm = document.getElementById('sidecarForm');
        const promptPreset = document.getElementById('promptPreset');
        const customPromptCronGroup = document.getElementById('customPromptCronGroup');
        const promptCronExpr = document.getElementById('promptCronExpr');
        const promptProject = document.getElementById('promptProject');

        function escapeHtml(str) {
            if (str === null || str === undefined) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function showToast(msg) {
            const toast = document.getElementById('toast');
            const toastMsg = document.getElementById('toastMessage');
            if (!toast || !toastMsg) return;
            toastMsg.textContent = msg;
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 3500);
        }

        async function fetchProjects() {
            try {
                const res = await fetch('/api/projects');
                if (res.ok) {
                    projectsData = await res.json();
                    promptProject.innerHTML = '';
                    for (const proj of projectsData) {
                        const opt = document.createElement('option');
                        opt.value = proj.id;
                        opt.textContent = proj.name + (proj.isWorkspaceOnly ? ' (Workspace)' : '');
                        promptProject.appendChild(opt);
                    }
                }
            } catch (e) {}
        }

        async function fetchSidecars() {
            try {
                const res = await fetch('/api/sidecars');
                if (!res.ok) throw new Error('Failed to load sidecars');
                sidecarsData = await res.json();
                renderList();
            } catch (e) {
                listContainer.innerHTML = '<div class="error-banner">Failed to load sidecars: ' + escapeHtml(e.message) + '</div>';
            }
        }

        function renderList() {
            if (!sidecarsData || sidecarsData.length === 0) {
                listContainer.innerHTML = \`
                    <div class="empty-state">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                            <line x1="8" y1="21" x2="16" y2="21"></line>
                            <line x1="12" y1="17" x2="12" y2="21"></line>
                        </svg>
                        <p>No sidecars configured yet. Add an autonomous worker or scheduled agent prompt.</p>
                        <button type="button" class="btn-primary" onclick="document.getElementById('openNewSidecarModalBtn').click()">
                            <span>+ Create Sidecar</span>
                        </button>
                    </div>\`;
                return;
            }

            let html = '';
            for (const s of sidecarsData) {
                const isChecked = s.enabled ? 'checked' : '';
                const escId = escapeHtml(s.id);
                const escDisplayName = escapeHtml(s.displayName || s.id);
                const escDescription = escapeHtml(s.description || '');
                const escCronExpr = escapeHtml(s.cronExpr || '');
                const escCronDesc = escapeHtml(s.cronDescription || s.cronExpr || '');
                const escCommand = escapeHtml(s.command || '');
                const escArgs = escapeHtml((s.args || []).join(' '));
                const escProjectId = escapeHtml(s.projectId || '');
                const escRestartPolicy = escapeHtml(s.restartPolicy || 'always');
                const escPid = escapeHtml(s.pid || '');

                let statusBadge = '<span class="chip chip-muted">STOPPED</span>';
                if (s.status === 'running') statusBadge = '<span class="chip chip-green"><span class="status-dot status-dot-success"></span> RUNNING ' + (s.pid ? '(PID ' + escPid + ')' : '') + '</span>';
                else if (s.status === 'scheduled') statusBadge = '<span class="chip chip-cyan"><span class="status-dot status-dot-success"></span> SCHEDULED</span>';
                else if (s.status === 'starting') statusBadge = '<span class="chip chip-purple"><span class="status-dot status-dot-warning"></span> STARTING</span>';

                const typeBadge = s.isScheduled ? '<span class="chip chip-purple">SCHEDULED JOB</span>' : '<span class="chip chip-cyan">WORKER</span>';

                let detailsChip = '';
                if (s.isScheduled) {
                    detailsChip = '<span class="chip">⏰ ' + escCronDesc + ' <code>' + escCronExpr + '</code></span>';
                } else {
                    detailsChip = '<span class="chip">⚙️ <code>' + escCommand + ' ' + escArgs + '</code> (Restart: ' + escRestartPolicy + ')</span>';
                }

                let projChip = '';
                if (s.projectId) {
                    projChip = '<span class="chip">📁 Project: <code>' + escProjectId + '</code></span>';
                }

                let nextRunChip = '';
                if (s.nextRun) {
                    const d = new Date(s.nextRun);
                    nextRunChip = '<span class="chip chip-muted">Next run: ' + escapeHtml(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + ' (' + escapeHtml(d.toLocaleDateString()) + ')</span>';
                }

                html += \`
                <div class="content-card" data-id="\${escId}">
                    <div class="card-header">
                        <div>
                            <div class="card-title-row">
                                <span class="card-title">\${escDisplayName}</span>
                                <span class="card-id-code">\${escId}</span>
                                \${typeBadge}
                                \${statusBadge}
                            </div>
                        </div>
                        <div>
                            <label class="switch" title="Toggle On/Off">
                                <input type="checkbox" class="toggle-switch-input" data-id="\${escId}" \${isChecked}>
                                <span class="slider"></span>
                            </label>
                        </div>
                    </div>

                    \${s.description ? '<p class="card-desc">' + escDescription + '</p>' : ''}

                    <div class="card-chips">
                        \${detailsChip}
                        \${projChip}
                        \${nextRunChip}
                    </div>

                    <div class="card-actions">
                        <div class="actions-left">
                            <button type="button" class="btn-secondary btn-run" data-id="\${escId}" title="Run now">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                                </svg>
                                <span>Run Now</span>
                            </button>
                            <button type="button" class="btn-secondary btn-logs" data-id="\${escId}" title="View recent logs">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line>
                                </svg>
                                <span>Logs</span>
                            </button>
                            <button type="button" class="btn-secondary btn-edit" data-id="\${escId}" title="Edit sidecar">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                                </svg>
                                <span>Edit</span>
                            </button>
                        </div>
                        <div class="actions-right">
                            <button type="button" class="btn-danger btn-delete" data-id="\${escId}" title="Delete sidecar">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                    <polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                </svg>
                                <span>Delete</span>
                            </button>
                        </div>
                    </div>
                </div>\`;
            }
            listContainer.innerHTML = html;

            // Attach event listeners
            document.querySelectorAll('.toggle-switch-input').forEach(input => {
                input.addEventListener('change', async (e) => {
                    const id = e.target.dataset.id;
                    const enabled = e.target.checked;
                    try {
                        const res = await fetch('/api/sidecars/' + encodeURIComponent(id) + '/toggle', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ enabled })
                        });
                        if (res.ok) {
                            showToast(\`Sidecar '\${id}' \${enabled ? 'enabled' : 'disabled'}\`);
                            fetchSidecars();
                        } else {
                            e.target.checked = !enabled;
                            showToast('Failed to toggle sidecar');
                        }
                    } catch (err) {
                        e.target.checked = !enabled;
                        showToast('Error toggling sidecar');
                    }
                });
            });

            document.querySelectorAll('.btn-run').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const id = btn.dataset.id;
                    btn.disabled = true;
                    try {
                        const res = await fetch('/api/sidecars/' + encodeURIComponent(id) + '/run', { method: 'POST' });
                        if (res.ok) {
                            showToast(\`Triggered sidecar '\${id}' successfully\`);
                            setTimeout(fetchSidecars, 1000);
                        } else {
                            showToast('Failed to trigger execution');
                        }
                    } catch (e) {
                        showToast('Error triggering execution');
                    } finally {
                        btn.disabled = false;
                    }
                });
            });

            document.querySelectorAll('.btn-logs').forEach(btn => {
                btn.addEventListener('click', () => {
                    openLogs(btn.dataset.id);
                });
            });

            document.querySelectorAll('.btn-edit').forEach(btn => {
                btn.addEventListener('click', () => {
                    openEdit(btn.dataset.id);
                });
            });

            document.querySelectorAll('.btn-delete').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const id = btn.dataset.id;
                    if (confirm(\`Are you sure you want to delete sidecar '\${id}'?\`)) {
                        try {
                            const res = await fetch('/api/sidecars/' + encodeURIComponent(id), { method: 'DELETE' });
                            if (res.ok) {
                                showToast(\`Deleted sidecar '\${id}'\`);
                                fetchSidecars();
                            } else {
                                showToast('Failed to delete sidecar');
                            }
                        } catch (e) {
                            showToast('Error deleting sidecar');
                        }
                    }
                });
            });
        }

        async function openLogs(id) {
            currentLogSidecarId = id;
            document.getElementById('logModalTitle').textContent = \`Logs: \${id}\`;
            document.getElementById('logContent').textContent = 'Loading logs...';
            logModal.classList.add('active');
            refreshLogs();
        }

        async function refreshLogs() {
            if (!currentLogSidecarId) return;
            try {
                const res = await fetch('/api/sidecars/' + encodeURIComponent(currentLogSidecarId) + '/logs');
                if (res.ok) {
                    const data = await res.json();
                    document.getElementById('logContent').textContent = data.logs || 'No logs recorded yet.';
                }
            } catch (e) {
                document.getElementById('logContent').textContent = 'Error fetching logs: ' + e.message;
            }
        }

        function openEdit(id) {
            const s = sidecarsData.find(item => item.id === id);
            if (!s) return;

            document.getElementById('modalTitle').textContent = 'Edit Sidecar: ' + id;
            document.getElementById('formMode').value = 'edit';
            document.getElementById('sidecarId').value = s.id;
            document.getElementById('sidecarId').readOnly = true;
            document.getElementById('sidecarDisplayName').value = s.displayName || '';
            document.getElementById('sidecarDescription').value = s.description || '';
            document.getElementById('sidecarEnabled').checked = s.enabled;

            if (s.isScheduled) {
                if (s.args && s.args[1] === 'agentapi') {
                    switchTab('promptTab');
                    promptCronExpr.value = s.cronExpr || '0 * * * *';
                    promptPreset.value = 'custom';
                    customPromptCronGroup.style.display = 'block';
                    promptProject.value = s.projectId || 'outside-of-project';
                    promptContent.value = s.args[s.args.length - 1] || '';
                } else {
                    switchTab('commandTab');
                    document.getElementById('commandCronExpr').value = s.cronExpr || '*/15 * * * *';
                    document.getElementById('commandExec').value = s.args ? s.args[1] : '';
                    document.getElementById('commandArgs').value = s.args ? s.args.slice(2).join('\\n') : '';
                }
            } else {
                switchTab('workerTab');
                document.getElementById('workerCommand').value = s.command || '';
                document.getElementById('workerArgs').value = (s.args || []).join('\\n');
                document.getElementById('workerRestartPolicy').value = s.restartPolicy || 'always';
            }

            modal.classList.add('active');
        }

        function switchTab(tabId) {
            activeTab = tabId;
            document.querySelectorAll('.tab-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tab === tabId);
            });
            document.querySelectorAll('.tab-pane').forEach(pane => {
                pane.classList.toggle('active', pane.id === tabId);
            });
        }

        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                switchTab(btn.dataset.tab);
            });
        });

        promptPreset.addEventListener('change', () => {
            if (promptPreset.value === 'custom') {
                customPromptCronGroup.style.display = 'block';
            } else {
                customPromptCronGroup.style.display = 'none';
                promptCronExpr.value = promptPreset.value;
            }
        });

        document.getElementById('openNewSidecarModalBtn').addEventListener('click', () => {
            document.getElementById('modalTitle').textContent = 'Define New Sidecar';
            document.getElementById('formMode').value = 'create';
            document.getElementById('sidecarId').value = '';
            document.getElementById('sidecarId').readOnly = false;
            document.getElementById('sidecarDisplayName').value = '';
            document.getElementById('sidecarDescription').value = '';
            document.getElementById('sidecarEnabled').checked = true;
            document.getElementById('promptContent').value = '';
            promptPreset.value = '0 * * * *';
            promptCronExpr.value = '0 * * * *';
            customPromptCronGroup.style.display = 'none';
            switchTab('promptTab');
            modal.classList.add('active');
        });

        document.getElementById('closeModalBtn').addEventListener('click', () => modal.classList.remove('active'));
        document.getElementById('cancelModalBtn').addEventListener('click', () => modal.classList.remove('active'));
        document.getElementById('closeLogModalBtn').addEventListener('click', () => logModal.classList.remove('active'));
        document.getElementById('doneLogModalBtn').addEventListener('click', () => logModal.classList.remove('active'));
        document.getElementById('refreshLogBtn').addEventListener('click', refreshLogs);
        document.getElementById('refreshBtn').addEventListener('click', fetchSidecars);

        sidecarForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const id = document.getElementById('sidecarId').value.trim();
            const displayName = document.getElementById('sidecarDisplayName').value.trim();
            const description = document.getElementById('sidecarDescription').value.trim();
            const enabled = document.getElementById('sidecarEnabled').checked;

            const payload = {
                id,
                displayName: displayName || id,
                description,
                enabled
            };

            if (activeTab === 'promptTab') {
                payload.isScheduled = true;
                payload.builtin = 'schedule';
                const cron = promptPreset.value === 'custom' ? promptCronExpr.value.trim() : promptPreset.value;
                const project = promptProject.value;
                const model = document.getElementById('promptModel').value;
                const prompt = document.getElementById('promptContent').value.trim();
                if (!prompt) {
                    alert('Please enter prompt instructions for the agent.');
                    return;
                }

                payload.projectId = project;
                const agentArgs = [cron, 'agentapi', 'new-conversation'];
                if (model && model !== 'inherit') {
                    agentArgs.push('--model=' + model);
                }
                agentArgs.push(prompt);
                payload.args = agentArgs;
            } else if (activeTab === 'commandTab') {
                payload.isScheduled = true;
                payload.builtin = 'schedule';
                const cron = document.getElementById('commandCronExpr').value.trim();
                const exec = document.getElementById('commandExec').value.trim();
                const rawArgs = document.getElementById('commandArgs').value.split('\\n').map(s => s.trim()).filter(Boolean);
                if (!exec) {
                    alert('Please specify a command executable.');
                    return;
                }
                payload.args = [cron, exec, ...rawArgs];
            } else if (activeTab === 'workerTab') {
                payload.isScheduled = false;
                const command = document.getElementById('workerCommand').value.trim();
                const rawArgs = document.getElementById('workerArgs').value.split('\\n').map(s => s.trim()).filter(Boolean);
                const restartPolicy = document.getElementById('workerRestartPolicy').value;
                if (!command) {
                    alert('Please specify a worker executable.');
                    return;
                }
                payload.command = command;
                payload.args = rawArgs;
                payload.restartPolicy = restartPolicy;
            }

            try {
                const res = await fetch('/api/sidecars', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (res.ok) {
                    modal.classList.remove('active');
                    showToast(\`Sidecar '\${id}' saved successfully!\`);
                    fetchSidecars();
                } else {
                    const err = await res.json();
                    alert('Error saving sidecar: ' + (err.error || 'Unknown error'));
                }
            } catch (err) {
                alert('Network error saving sidecar: ' + err.message);
            }
        });

        // Auto ID slug generator from display name on create
        document.getElementById('sidecarDisplayName').addEventListener('input', (e) => {
            if (document.getElementById('formMode').value === 'create' && !document.getElementById('sidecarId').dataset.userEdited) {
                document.getElementById('sidecarId').value = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            }
        });
        document.getElementById('sidecarId').addEventListener('input', () => {
            document.getElementById('sidecarId').dataset.userEdited = 'true';
        });

        fetchProjects();
        fetchSidecars();
    `;

    return renderPageLayout({
        title: 'Google Antigravity - Sidecar Manager',
        subtitle: 'Configure autonomous background sidecar processes and scheduled agent prompts',
        statusPill,
        bodyHtml,
        scriptExtra,
        cardMaxWidth: 920
    });
}

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

    function runInjection() {
        tryInjectSidebar();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runInjection);
    } else {
        runInjection();
    }

    const observer = new MutationObserver(() => {
        if (!document.getElementById('agy-injected-tools-group')) {
            tryInjectSidebar();
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });
})();
`;
}

// Hop-by-hop headers defined in RFC 7230 / RFC 9110 to strip when proxying
const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'transfer-encoding',
    'upgrade',
]);

// Dedicated persistent HTTP Agent for upstream proxy requests
const proxyAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 256,
    maxFreeSockets: 64,
    timeout: 0
});

// Forward request to ttyd Web Terminal
function proxyToTerminal(req, res, targetPath) {
    if (req.socket) req.socket.setNoDelay(true);
    if (res.socket) res.socket.setNoDelay(true);

    const proxyHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
        const lowerKey = key.toLowerCase();
        if (!HOP_BY_HOP_HEADERS.has(lowerKey)) {
            proxyHeaders[key] = value;
        }
    }
    proxyHeaders['host'] = `localhost:${TERMINAL_PORT}`;
    proxyHeaders['origin'] = `http://localhost:${TERMINAL_PORT}`;

    const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: TERMINAL_PORT,
        path: targetPath,
        method: req.method,
        headers: proxyHeaders,
        agent: proxyAgent
    }, (proxyRes) => {
        if (proxyRes.socket) proxyRes.socket.setNoDelay(true);

        const resHeaders = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
            const lowerKey = key.toLowerCase();
            if (!HOP_BY_HOP_HEADERS.has(lowerKey)) {
                resHeaders[key] = value;
            }
        }
        resHeaders['x-accel-buffering'] = 'no';
        res.writeHead(proxyRes.statusCode, resHeaders);
        res.flushHeaders();

        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        if (!res.headersSent) {
            res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderServiceStartingPage('Host Terminal'));
        } else {
            res.destroy();
        }
    });

    req.pipe(proxyReq, { end: true });
}

// Forward request to code-server Web IDE
function proxyToIde(req, res, targetPath) {
    if (req.socket) req.socket.setNoDelay(true);
    if (res.socket) res.socket.setNoDelay(true);

    const proxyHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
        const lowerKey = key.toLowerCase();
        if (!HOP_BY_HOP_HEADERS.has(lowerKey)) {
            proxyHeaders[key] = value;
        }
    }
    proxyHeaders['host'] = `localhost:${IDE_PORT}`;
    proxyHeaders['origin'] = `http://localhost:${IDE_PORT}`;

    const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: IDE_PORT,
        path: targetPath,
        method: req.method,
        headers: proxyHeaders,
        agent: proxyAgent
    }, (proxyRes) => {
        if (proxyRes.socket) proxyRes.socket.setNoDelay(true);

        const resHeaders = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
            const lowerKey = key.toLowerCase();
            if (!HOP_BY_HOP_HEADERS.has(lowerKey)) {
                if (lowerKey === 'location' && typeof value === 'string') {
                    let newLoc = value;
                    if (newLoc.startsWith('/')) {
                        newLoc = '/ide' + newLoc;
                    }
                    resHeaders[key] = newLoc;
                } else {
                    resHeaders[key] = value;
                }
            }
        }
        resHeaders['x-accel-buffering'] = 'no';
        res.writeHead(proxyRes.statusCode, resHeaders);
        res.flushHeaders();

        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        if (!res.headersSent) {
            res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderServiceStartingPage('Web IDE'));
        } else {
            res.destroy();
        }
    });

    req.pipe(proxyReq, { end: true });
}

// Helper to determine if a request path corresponds to a browser SPA frontend route
function isSpaRoute(pathname) {
    if (pathname === '/' || pathname === '/index.html') return true;
    if (pathname.startsWith('/c/') || pathname === '/c') return true;
    if (pathname.startsWith('/history')) return true;
    if (pathname.startsWith('/projects')) return true;
    if (pathname.startsWith('/tasks')) return true;
    return false;
}

// Create HTTP Proxy Server
const server = http.createServer(async (req, res) => {
    try {
        applySecurityHeaders(res, req);
        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        // 1. Handle /status health check endpoint (ALWAYS UNAUTHENTICATED)
        if (parsedUrl.pathname === '/status' || parsedUrl.pathname === '/status/') {
            checkPortFile();
            const health = await checkUpstreamHealth(TARGET_PORT);
            const statusCode = health.up ? 200 : 503;

            const wantsJson = req.headers.accept?.includes('application/json') || parsedUrl.searchParams.get('format') === 'json';
            if (wantsJson) {
                res.writeHead(statusCode, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-cache, no-store, must-revalidate'
                });
                res.end(JSON.stringify({
                    status: health.up ? 'ok' : 'error'
                }, null, 2));
                return;
            }

            res.writeHead(statusCode, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
            res.end(renderStatusPage(health));
            return;
        }

        // 2. Handle Logout GET or POST
        if (parsedUrl.pathname === '/__auth/logout') {
            const cookies = parseCookies(req);
            if (cookies['antigravity_session']) {
                activeSessions.delete(cookies['antigravity_session']);
            }
            res.writeHead(302, {
                'Set-Cookie': 'antigravity_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
                'Location': '/__auth/login'
            });
            res.end();
            return;
        }

        // 3. Handle Login POST
        if (parsedUrl.pathname === '/__auth/login' && req.method === 'POST') {
            const clientIp = getClientIp(req);
            const rateCheck = checkRateLimit(clientIp);

            if (!rateCheck.allowed) {
                res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(renderLoginPage(rateCheck.message));
                return;
            }

            let body = '';
            let exceeded = false;
            const MAX_BODY_BYTES = 16 * 1024; // 16 KB max payload

            req.on('data', chunk => {
                if (exceeded) return;
                body += chunk.toString();
                if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
                    exceeded = true;
                    res.writeHead(413, { 'Content-Type': 'text/plain' });
                    res.end('Payload Too Large');
                    req.destroy();
                }
            });

            req.on('end', () => {
                if (exceeded) return;
                const params = new URLSearchParams(body);
                const enteredPassword = params.get('password') || '';

                if (AUTH_PASSWORD && safeCompare(enteredPassword, AUTH_PASSWORD)) {
                    loginRateLimiter.delete(clientIp);

                    const sessionToken = crypto.randomBytes(32).toString('hex');
                    const now = Date.now();
                    activeSessions.set(sessionToken, {
                        createdAt: now,
                        expiresAt: now + SESSION_TTL_MS
                    });

                    const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
                    const secureFlag = isHttps ? '; Secure' : '';

                    res.writeHead(302, {
                        'Set-Cookie': `antigravity_session=${sessionToken}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secureFlag}`,
                        'Location': '/?useWebSocket=true'
                    });
                    res.end();
                } else {
                    recordFailedAttempt(clientIp);
                    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(renderLoginPage('Incorrect password. Please try again.'));
                }
            });
            return;
        }

        // 4. Check Authentication for ALL other routes (/sidecars, /ide, /terminal, /, /api/*, etc.)
        if (!isAuthenticated(req)) {
            if (parsedUrl.pathname.startsWith('/api/')) {
                res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: 'Unauthorized. Please sign in.' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderLoginPage());
            return;
        }

        // 5. Handle /sidecars UI route (AUTHENTICATED)
        if (parsedUrl.pathname === '/sidecars' || parsedUrl.pathname === '/sidecars/') {
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
            res.end(renderSidecarsPage());
            return;
        }

        // 6. Handle /api/projects REST endpoint (AUTHENTICATED)
        if (parsedUrl.pathname === '/api/projects' && req.method === 'GET') {
            const projects = sidecarManager ? sidecarManager.listProjects() : [];
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(projects));
            return;
        }

        // 7. Handle /api/sidecars* REST endpoints (AUTHENTICATED)
        if (parsedUrl.pathname === '/api/sidecars' || parsedUrl.pathname.startsWith('/api/sidecars/')) {
            if (!sidecarManager) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: 'Sidecar manager subsystem not available.' }));
                return;
            }

            // GET /api/sidecars -> List all
            if (parsedUrl.pathname === '/api/sidecars' && req.method === 'GET') {
                const sidecars = sidecarManager.listSidecars();
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(sidecars));
                return;
            }

            // POST /api/sidecars -> Save/create
            if (parsedUrl.pathname === '/api/sidecars' && req.method === 'POST') {
                try {
                    const body = await readJsonBody(req);
                    const saved = await sidecarManager.saveSidecar(body);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify(saved));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: e.message }));
                }
                return;
            }

            // Route matching: /api/sidecars/:id/...
            const subPath = parsedUrl.pathname.replace(/^\/api\/sidecars\/?/, '');
            const parts = subPath.split('/');
            const sidecarId = decodeURIComponent(parts[0]);
            const action = parts[1];

            // POST /api/sidecars/:id/toggle
            if (action === 'toggle' && req.method === 'POST') {
                try {
                    const body = await readJsonBody(req);
                    const updated = await sidecarManager.toggleSidecar(sidecarId, body.enabled);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify(updated));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: e.message }));
                }
                return;
            }

            // POST /api/sidecars/:id/run
            if (action === 'run' && req.method === 'POST') {
                try {
                    const result = await sidecarManager.triggerSidecar(sidecarId);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify(result));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: e.message }));
                }
                return;
            }

            // GET /api/sidecars/:id/logs
            if (action === 'logs' && req.method === 'GET') {
                const logs = sidecarManager.getLogs(sidecarId);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ logs }));
                return;
            }

            // DELETE /api/sidecars/:id
            if (!action && req.method === 'DELETE') {
                try {
                    await sidecarManager.deleteSidecar(sidecarId);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: e.message }));
                }
                return;
            }

            // GET /api/sidecars/:id
            if (!action && req.method === 'GET') {
                const s = sidecarManager.getSidecar(sidecarId);
                if (!s) {
                    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: 'Sidecar not found' }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify(s));
                }
                return;
            }
        }

        // 8. Handle /terminal and /terminal/* routes
        if (parsedUrl.pathname === '/terminal' || parsedUrl.pathname.startsWith('/terminal/')) {
            if (!ENABLE_TERMINAL) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Host Terminal is disabled (ENABLE_TERMINAL=false)');
                return;
            }
            if (parsedUrl.pathname === '/terminal') {
                res.writeHead(302, { 'Location': '/terminal/' });
                res.end();
                return;
            }
            proxyToTerminal(req, res, req.url);
            return;
        }

        // 9. Handle /ide and /ide/* routes
        if (parsedUrl.pathname === '/ide' || parsedUrl.pathname.startsWith('/ide/')) {
            if (!ENABLE_IDE) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Web IDE is disabled (ENABLE_IDE=false)');
                return;
            }
            if (parsedUrl.pathname === '/ide') {
                res.writeHead(302, { 'Location': '/ide/' });
                res.end();
                return;
            }
            const strippedPath = req.url.replace(/^\/ide/, '') || '/';
            proxyToIde(req, res, strippedPath);
            return;
        }

        // 10. Ensure useWebSocket=true query param is present for all browser SPA routes
        if (req.method === 'GET' && isSpaRoute(parsedUrl.pathname)) {
            if (parsedUrl.searchParams.get('useWebSocket') !== 'true') {
                parsedUrl.searchParams.set('useWebSocket', 'true');
                res.writeHead(302, {
                    'Location': `${parsedUrl.pathname}${parsedUrl.search}`
                });
                res.end();
                return;
            }
        }

        // 11. If target port is not ready yet
        if (!TARGET_PORT) {
            res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderStartingPage());
            return;
        }

        // 12. Proxy HTTP Request to Antigravity agy with DOM injection on HTML responses
        if (req.socket) req.socket.setNoDelay(true);
        if (res.socket) res.socket.setNoDelay(true);

        const proxyHeaders = {};
        for (const [key, value] of Object.entries(req.headers)) {
            const lowerKey = key.toLowerCase();
            if (!HOP_BY_HOP_HEADERS.has(lowerKey)) {
                proxyHeaders[key] = value;
            }
        }
        proxyHeaders['host'] = `localhost:${TARGET_PORT}`;
        proxyHeaders['origin'] = `http://localhost:${TARGET_PORT}`;
        if (req.headers['referer']) {
            proxyHeaders['referer'] = req.headers['referer'].replace(/^https?:\/\/[^\/]+/, `http://localhost:${TARGET_PORT}`);
        }

        // Request uncompressed body for SPA routes to enable DOM injection
        if (isSpaRoute(parsedUrl.pathname)) {
            proxyHeaders['accept-encoding'] = 'identity';
        }

        const proxyReq = http.request({
            hostname: '127.0.0.1',
            port: TARGET_PORT,
            path: req.url,
            method: req.method,
            headers: proxyHeaders,
            agent: proxyAgent,
        }, (proxyRes) => {
            if (proxyRes.socket) proxyRes.socket.setNoDelay(true);

            const resHeaders = {};
            for (const [key, value] of Object.entries(proxyRes.headers)) {
                const lowerKey = key.toLowerCase();
                if (!HOP_BY_HOP_HEADERS.has(lowerKey)) {
                    resHeaders[key] = value;
                }
            }

            const allowedOrigins = process.env.ALLOWED_ORIGINS ? new Set(process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())) : null;
            if (resHeaders['access-control-allow-origin'] && req.headers.origin) {
                if (allowedOrigins && allowedOrigins.has(req.headers.origin)) {
                    resHeaders['access-control-allow-origin'] = req.headers.origin;
                } else if (!allowedOrigins) {
                    delete resHeaders['access-control-allow-origin'];
                }
            }

            resHeaders['x-accel-buffering'] = 'no';

            const isHtmlResponse = (resHeaders['content-type'] || '').includes('text/html');

            // INTERCEPT HTML RESPONSES TO INJECT WORKSPACE TOOLS BUTTONS
            if (isHtmlResponse && req.method === 'GET') {
                const chunks = [];
                proxyRes.on('data', (chunk) => {
                    chunks.push(chunk);
                });
                proxyRes.on('end', () => {
                    let html = Buffer.concat(chunks).toString('utf8');
                    const csrfMatch = html.match(/"csrfToken":"([^"]+)"/);
                    if (csrfMatch && sidecarManager) {
                        sidecarManager.setCsrfToken(csrfMatch[1]);
                    }
                    const customScript = buildInjectedScript();
                    if (customScript) {
                        const injection = `<style>${INJECTED_UI_STYLES}</style><script id="agy-injected-tools-script">${customScript}</script>`;
                        if (html.includes('</body>')) {
                            html = html.replace('</body>', `${injection}</body>`);
                        } else if (html.includes('</html>')) {
                            html = html.replace('</html>', `${injection}</html>`);
                        } else {
                            html += injection;
                        }
                    }
                    resHeaders['content-length'] = Buffer.byteLength(html, 'utf8');
                    delete resHeaders['content-encoding'];
                    res.writeHead(proxyRes.statusCode, resHeaders);
                    res.end(html);
                });
                return;
            }

            res.writeHead(proxyRes.statusCode, resHeaders);
            res.flushHeaders();

            proxyRes.pipe(res);
        });

        proxyReq.on('socket', (sock) => {
            sock.setNoDelay(true);
        });

        const clientAbortHandler = () => {
            if (!res.writableFinished && !res.writableEnded && !proxyReq.destroyed) {
                proxyReq.destroy();
            }
        };

        res.on('close', clientAbortHandler);
        res.on('error', clientAbortHandler);
        req.on('error', clientAbortHandler);

        proxyReq.on('error', (err) => {
            console.error('[HTTP Proxy Error]', err.message);
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Antigravity upstream server unavailable.');
            } else {
                res.destroy();
            }
        });

        req.pipe(proxyReq, { end: true });
    } catch (err) {
        console.error('[HTTP Gateway Error]', err);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Gateway Error');
        } else {
            res.destroy();
        }
    }
});

// Handle WebSocket / Upgrade requests
server.on('upgrade', (req, clientSocket, head) => {
    if (!isAuthenticated(req)) {
        clientSocket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        clientSocket.destroy();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let targetPort = TARGET_PORT;
    let targetPath = req.url;

    if (parsedUrl.pathname.startsWith('/terminal')) {
        if (!ENABLE_TERMINAL) {
            clientSocket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            clientSocket.destroy();
            return;
        }
        targetPort = TERMINAL_PORT;
        targetPath = req.url;
    } else if (parsedUrl.pathname.startsWith('/ide')) {
        if (!ENABLE_IDE) {
            clientSocket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            clientSocket.destroy();
            return;
        }
        targetPort = IDE_PORT;
        targetPath = req.url.replace(/^\/ide/, '') || '/';
    } else {
        if (!TARGET_PORT) {
            clientSocket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
            clientSocket.destroy();
            return;
        }
        targetPort = TARGET_PORT;
    }

    clientSocket.setNoDelay(true);

    const proxyHeaders = { ...req.headers };
    proxyHeaders['host'] = `localhost:${targetPort}`;
    proxyHeaders['origin'] = `http://localhost:${targetPort}`;
    if (proxyHeaders['referer']) {
        proxyHeaders['referer'] = proxyHeaders['referer'].replace(/^https?:\/\/[^\/]+/, `http://localhost:${targetPort}`);
    }

    const upstreamReq = http.request({
        hostname: '127.0.0.1',
        port: targetPort,
        path: targetPath,
        method: req.method,
        headers: proxyHeaders,
        agent: false,
    });

    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
        upstreamSocket.setNoDelay(true);

        let rawResponse = `HTTP/1.1 101 Switching Protocols\r\n`;
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (Array.isArray(value)) {
                for (const v of value) rawResponse += `${key}: ${v}\r\n`;
            } else {
                rawResponse += `${key}: ${value}\r\n`;
            }
        }
        rawResponse += '\r\n';

        clientSocket.write(rawResponse);
        if (upstreamHead && upstreamHead.length > 0) clientSocket.write(upstreamHead);
        if (head && head.length > 0) upstreamSocket.write(head);

        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);

        const cleanup = () => {
            upstreamSocket.destroy();
            clientSocket.destroy();
        };

        upstreamSocket.on('error', cleanup);
        clientSocket.on('error', cleanup);
        upstreamSocket.on('close', cleanup);
        clientSocket.on('close', cleanup);
        upstreamSocket.on('end', () => clientSocket.end());
        clientSocket.on('end', () => upstreamSocket.end());
    });

    upstreamReq.on('response', (upstreamRes) => {
        let rawResponse = `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage || ''}\r\n`;
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (Array.isArray(value)) {
                for (const v of value) rawResponse += `${key}: ${v}\r\n`;
            } else {
                rawResponse += `${key}: ${value}\r\n`;
            }
        }
        rawResponse += '\r\n';
        clientSocket.write(rawResponse);
        upstreamRes.pipe(clientSocket);
    });

    upstreamReq.on('error', (err) => {
        console.error('[WebSocket Upgrade Error]', err.message);
        clientSocket.destroy();
    });

    upstreamReq.end();
});

// Update dynamic target port
function setTargetPort(port) {
    TARGET_PORT = parseInt(port, 10);
    console.log(`[Proxy Gateway] 🔗 Bridged port ${LISTEN_PORT} -> http://127.0.0.1:${TARGET_PORT}`);
    if (sidecarManager) {
        sidecarManager.setLsAddress(`127.0.0.1:${TARGET_PORT}`);
        sidecarManager.getCsrfToken().catch(() => {});
    }
}

// Watch port file and logs for dynamic port detection
function checkPortFile() {
    try {
        if (fs.existsSync(PORT_FILE)) {
            const content = fs.readFileSync(PORT_FILE, 'utf8').trim();
            const port = parseInt(content, 10);
            if (port) {
                if (port !== TARGET_PORT) {
                    setTargetPort(port);
                }
                return;
            }
        }

        const possibleLogs = [
            '/home/developer/.gemini/antigravity-cli/cli.log'
        ];
        for (const logPath of possibleLogs) {
            if (fs.existsSync(logPath)) {
                const logHead = fs.readFileSync(logPath, 'utf8').slice(0, 4096);
                const match = logHead.match(/listening on random port at (\d+) for HTTP\s*$/m) ||
                              logHead.match(/(?:http:\/\/localhost:|http:\/\/127\.0\.0\.1:)(\d+)/i);
                if (match && match[1]) {
                    const port = parseInt(match[1], 10);
                    if (port && port !== TARGET_PORT) {
                        setTargetPort(port);
                    }
                    return;
                }
            }
        }
    } catch (e) {}
}

setInterval(checkPortFile, 500);
checkPortFile();

// Initialize Sidecar subsystem
if (sidecarManager) {
    sidecarManager.init().catch(err => {
        console.error('[Proxy Gateway] Failed to initialize Sidecar Manager:', err);
    });
}

server.listen(LISTEN_PORT, '0.0.0.0', () => {
    console.log(`[Proxy Gateway] 🛡️  Listening on 0.0.0.0:${LISTEN_PORT} (Password Protection: ${AUTH_PASSWORD ? 'ENABLED' : 'DISABLED'})`);
});
