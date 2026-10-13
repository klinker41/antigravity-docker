'use strict';

const crypto = require('node:crypto');

// Constant-time string comparison using SHA-256 digests to prevent timing attacks
function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const hashA = crypto.createHash('sha256').update(a).digest();
    const hashB = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(hashA, hashB);
}

// Read raw request body as string with maximum byte length protection.
// Supports both Web Fetch Request / ReadableStream and Node.js Readable streams.
async function readRequestBody(req, maxBytes = 64 * 1024) {
    const contentLengthHeader = typeof req?.headers?.get === 'function'
        ? req.headers.get('content-length')
        : req?.headers?.['content-length'];
    if (contentLengthHeader && parseInt(contentLengthHeader, 10) > maxBytes) {
        throw new Error('Payload Too Large');
    }

    const webStream = typeof req?.getReader === 'function'
        ? req
        : (typeof req?.body?.getReader === 'function' ? req.body : null);

    if (webStream) {
        const reader = webStream.getReader();
        const chunks = [];
        let totalBytes = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.length;
            if (totalBytes > maxBytes) {
                try { await reader.cancel(); } catch {}
                throw new Error('Payload Too Large');
            }
            chunks.push(value);
        }
        return Buffer.concat(chunks).toString('utf8');
    }

    if (typeof req?.on === 'function') {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let totalBytes = 0;
            let exceeded = false;

            const onData = (chunk) => {
                if (exceeded) return;
                totalBytes += chunk.length;
                if (totalBytes > maxBytes) {
                    exceeded = true;
                    req.removeListener('data', onData);
                    req.removeListener('end', onEnd);
                    if (typeof req.resume === 'function') req.resume();
                    reject(new Error('Payload Too Large'));
                    return;
                }
                chunks.push(chunk);
            };

            const onEnd = () => {
                if (exceeded) return;
                resolve(Buffer.concat(chunks).toString('utf8'));
            };

            const onError = (err) => {
                if (exceeded) return;
                reject(err);
            };

            req.on('data', onData);
            req.on('end', onEnd);
            req.on('error', onError);
        });
    }

    if (typeof req?.text === 'function') {
        const text = await req.text();
        if (Buffer.byteLength(text, 'utf8') > maxBytes) {
            throw new Error('Payload Too Large');
        }
        return text;
    }

    return '';
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
    readRequestBody,
    readJsonBody,
};
