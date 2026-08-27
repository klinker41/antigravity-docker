'use strict';

const crypto = require('node:crypto');

// Constant-time string comparison using SHA-256 digests to prevent timing attacks
function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const hashA = crypto.createHash('sha256').update(a).digest();
    const hashB = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(hashA, hashB);
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

// Read raw request body as string with maximum byte length protection
function readRequestBody(req, maxBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
        let body = '';
        let exceeded = false;
        req.on('data', chunk => {
            if (exceeded) return;
            body += chunk.toString();
            if (Buffer.byteLength(body, 'utf8') > maxBytes) {
                exceeded = true;
                req.destroy();
                reject(new Error('Payload Too Large'));
            }
        });
        req.on('end', () => {
            if (exceeded) return;
            resolve(body);
        });
        req.on('error', reject);
    });
}

// Read and parse JSON body helper
async function readJsonBody(req, maxBytes = 64 * 1024) {
    const body = await readRequestBody(req, maxBytes);
    try {
        return body ? JSON.parse(body) : {};
    } catch (err) {
        throw new Error('Invalid JSON');
    }
}

module.exports = {
    safeCompare,
    applySecurityHeaders,
    readRequestBody,
    readJsonBody,
};
