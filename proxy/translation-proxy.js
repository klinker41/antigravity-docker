'use strict';

const http = require('node:http');
const https = require('node:https');

const DEFAULT_PORT = parseInt(process.env.TRANSLATION_PORT || '4405', 10);
const DEFAULT_UPSTREAM = process.env.CLOUDCODE_UPSTREAM_URL || 'https://cloudcode-pa.googleapis.com';

const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'transfer-encoding',
    'upgrade'
]);

function filterHeaders(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && !key.startsWith(':')) {
            out[key] = value;
        }
    }
    return out;
}

class TranslationProxy {
    constructor(options = {}) {
        this.port = options.port || DEFAULT_PORT;
        this.upstreamUrl = options.upstreamUrl || DEFAULT_UPSTREAM;
        this.modelsManager = options.modelsManager || null;
        this.server = null;
        this.isRunning = false;
    }

    start() {
        return new Promise((resolve, reject) => {
            if (this.isRunning) return resolve(this.server);

            this.server = http.createServer((req, res) => {
                this.handleRequest(req, res);
            });

            this.server.on('error', (err) => {
                console.error('[Translation Proxy] Server error:', err.message);
                if (!this.isRunning) reject(err);
            });

            this.server.listen(this.port, '127.0.0.1', () => {
                this.isRunning = true;
                console.log(`[Translation Proxy] 🚀 Listening on 127.0.0.1:${this.port} (Upstream: ${this.upstreamUrl})`);
                resolve(this.server);
            });
        });
    }

    stop() {
        return new Promise((resolve) => {
            if (!this.server || !this.isRunning) return resolve();
            this.server.close(() => {
                this.isRunning = false;
                console.log('[Translation Proxy] ⏹️  Stopped');
                resolve();
            });
        });
    }

    handleRequest(req, res) {
        const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

        // Health check endpoint
        if (parsedUrl.pathname === '/__proxy/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                port: this.port,
                upstream: this.upstreamUrl,
                timestamp: new Date().toISOString()
            }));
            return;
        }

        // Standard pass-through reverse proxy
        this.forwardPassThrough(req, res);
    }

    forwardPassThrough(req, res) {
        const targetUrl = new URL(req.url, this.upstreamUrl);
        const isHttps = targetUrl.protocol === 'https:';
        const client = isHttps ? https : http;

        const headers = filterHeaders(req.headers);
        headers['host'] = targetUrl.host;

        const proxyReq = client.request(targetUrl, {
            method: req.method,
            headers,
            timeout: 60000
        }, (proxyRes) => {
            const resHeaders = filterHeaders(proxyRes.headers);
            res.writeHead(proxyRes.statusCode, resHeaders);
            proxyRes.pipe(res);
        });

        proxyReq.on('timeout', () => {
            proxyReq.destroy(new Error('Gateway timeout after 60000ms'));
        });

        res.on('close', () => {
            if (!res.writableEnded && !proxyReq.destroyed) {
                proxyReq.destroy();
            }
        });

        proxyReq.on('error', (err) => {
            console.error('[Translation Proxy] Upstream error:', err.message);
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Translation Proxy upstream error',
                    details: err.message
                }));
            } else {
                res.destroy();
            }
        });

        req.pipe(proxyReq, { end: true });
    }
}

if (require.main === module) {
    const proxy = new TranslationProxy();
    proxy.start().catch((err) => {
        console.error('[Translation Proxy] Startup failed:', err);
        process.exit(1);
    });
}

module.exports = {
    TranslationProxy,
    DEFAULT_PORT,
    DEFAULT_UPSTREAM
};
