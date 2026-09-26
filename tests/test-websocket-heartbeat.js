const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

async function getFreePort() {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

test('WebSocket Heartbeat, Ping/Pong, & Media Upload Keepalive', { timeout: 15000 }, async (t) => {
    const TEST_PROXY_PORT = await getFreePort();

    // Mock upstream server that handles connect-websocket
    let lastUpstreamReceivedMsg = null;
    let upstreamWsRef = null;

    const mockUpstreamServer = Bun.serve({
        port: 0,
        fetch(req, srv) {
            if (srv.upgrade(req)) return;
            return new Response('Mock Upstream OK');
        },
        websocket: {
            open(ws) {
                upstreamWsRef = ws;
            },
            message(ws, msg) {
                lastUpstreamReceivedMsg = msg;
                try {
                    const parsed = JSON.parse(msg);
                    if (parsed.procedure === '/exa.language_server_pb.LanguageServerService/SaveMediaAsArtifact') {
                        // Simulate delay in upstream saving media (e.g. 500ms)
                        setTimeout(() => {
                            ws.send(JSON.stringify({
                                streamId: parsed.streamId,
                                type: 'data',
                                payload: { uri: 'file:///tmp/saved_media_test.png' }
                            }));
                            ws.send(JSON.stringify({
                                streamId: parsed.streamId,
                                type: 'end'
                            }));
                        }, 500);
                    }
                } catch (e) {}
            },
            close(ws) {}
        }
    });

    const TEST_TARGET_PORT = mockUpstreamServer.port;

    // Spawn proxy instance with test ports
    const proxyProc = spawn(process.execPath, [path.join(__dirname, '../proxy/auth-proxy.js')], {
        env: {
            ...process.env,
            AGY_PORT: String(TEST_PROXY_PORT),
            AGY_HUB_PORT: String(TEST_TARGET_PORT),
            INITIAL_TARGET_PORT: String(TEST_TARGET_PORT),
            PORT_FILE: '/tmp/test_ws_heartbeat_port_nonexistent',
            AUTH_PASSWORD: '', // unauthenticated for test
            ENABLE_IDE: 'false',
            ENABLE_TERMINAL: 'false'
        },
        stdio: 'pipe'
    });

    await new Promise((resolve) => {
        proxyProc.stdout.on('data', (d) => {
            if (d.toString().includes('Listening on')) resolve();
        });
        setTimeout(resolve, 1500);
    });

    try {
        await t.test('receives proactive heartbeats on /connect-websocket', async () => {
            const receivedFrames = [];
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PROXY_PORT}/connect-websocket`);

            await new Promise((resolve, reject) => {
                ws.onopen = resolve;
                ws.onerror = reject;
            });

            ws.onmessage = (event) => {
                try {
                    receivedFrames.push(JSON.parse(event.data));
                } catch (e) {}
            };

            // Wait 2.2 seconds to receive at least 2 heartbeats (interval is 1000ms)
            await new Promise(r => setTimeout(r, 2200));

            ws.close();

            const heartbeats = receivedFrames.filter(f => f.type === 'heartbeat');
            assert.ok(heartbeats.length >= 2, `Expected >= 2 heartbeats, received: ${heartbeats.length}`);
        });

        await t.test('immediately replies to client ping with pong and does not forward to upstream', async () => {
            lastUpstreamReceivedMsg = null;
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PROXY_PORT}/connect-websocket`);

            await new Promise((resolve, reject) => {
                ws.onopen = resolve;
                ws.onerror = reject;
            });

            const pongs = [];
            ws.onmessage = (event) => {
                try {
                    const parsed = JSON.parse(event.data);
                    if (parsed.type === 'pong') pongs.push(parsed);
                } catch (e) {}
            };

            const pingStreamId = 'probe-stream-123';
            ws.send(JSON.stringify({ streamId: pingStreamId, type: 'ping' }));

            await new Promise(r => setTimeout(r, 100));

            ws.close();

            assert.equal(pongs.length, 1, 'Should receive exactly 1 immediate pong');
            assert.equal(pongs[0].streamId, pingStreamId, 'Pong should include the matching streamId');
            assert.equal(lastUpstreamReceivedMsg, null, 'Ping should be handled at proxy without forwarding upstream');
        });

        await t.test('SaveMediaAsArtifact works and client liveness probe simulation survives >4s', async () => {
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PROXY_PORT}/connect-websocket`);

            await new Promise((resolve, reject) => {
                ws.onopen = resolve;
                ws.onerror = reject;
            });

            // Simulate client-side liveness probe from main.js:
            let inboundFrameSeq = 0;
            let livenessFailed = false;

            ws.onmessage = (event) => {
                inboundFrameSeq++;
            };

            // Start simulated liveness probe (checks every 2000ms; if inboundFrameSeq unchanged after 4000ms total, fails)
            let lastSeq = inboundFrameSeq;
            let timer = null;
            let checksRemaining = 2; // Check 2 intervals of 2000ms = 4000ms+

            const probePromise = new Promise((resolve) => {
                function runProbe() {
                    timer = setTimeout(() => {
                        if (inboundFrameSeq === lastSeq) {
                            livenessFailed = true;
                            resolve(false);
                        } else {
                            lastSeq = inboundFrameSeq;
                            checksRemaining--;
                            if (checksRemaining <= 0) {
                                resolve(true);
                            } else {
                                runProbe();
                            }
                        }
                    }, 2000);
                }
                runProbe();
            });

            // Now perform a media upload
            const mediaStreamId = 'media-upload-stream-1';
            let mediaResponse = null;

            const originalOnMessage = ws.onmessage;
            ws.onmessage = (event) => {
                inboundFrameSeq++;
                try {
                    const parsed = JSON.parse(event.data);
                    if (parsed.streamId === mediaStreamId && parsed.type === 'data') {
                        mediaResponse = parsed.payload;
                    }
                } catch (e) {}
            };

            // Send large dummy base64 payload (100KB)
            ws.send(JSON.stringify({
                streamId: mediaStreamId,
                type: 'start',
                procedure: '/exa.language_server_pb.LanguageServerService/SaveMediaAsArtifact',
                payload: {
                    originalFileName: 'test.png',
                    data: 'A'.repeat(100000)
                }
            }));

            const probeSurvived = await probePromise;
            clearTimeout(timer);
            ws.close();

            assert.ok(probeSurvived, 'Liveness probe should survive without timing out');
            assert.equal(livenessFailed, false, 'Liveness probe should not have failed');
            assert.ok(mediaResponse !== null, 'Media upload response should have been received');
            assert.equal(mediaResponse.uri, 'file:///tmp/saved_media_test.png');
        });
    } finally {
        proxyProc.kill();
        mockUpstreamServer.stop();
    }
});
