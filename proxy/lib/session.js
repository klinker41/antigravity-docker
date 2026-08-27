'use strict';

const { AUTH_PASSWORD, TRUST_PROXY } = require('./config');

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

module.exports = {
    SESSION_TTL_MS,
    activeSessions,
    loginRateLimiter,
    getClientIp,
    checkRateLimit,
    recordFailedAttempt,
    parseCookies,
    isAuthenticated,
};
