const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

test('Container Packaging & Module Resolution (DOCKER-01)', async (t) => {
    const rootDir = path.resolve(__dirname, '..');
    const dockerfilePath = path.join(rootDir, 'Dockerfile');
    const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8');

    await t.test('Dockerfile copies entire proxy directory or proxy/lib into /usr/local/bin', () => {
        // Ensure Dockerfile does not only copy auth-proxy.js without its lib dependencies
        const hasFullProxyCopy = /COPY\s+proxy\/\s+\/usr\/local\/bin\//.test(dockerfileContent);
        const hasLibCopy = /COPY\s+proxy\/lib\/?\s+\/usr\/local\/bin\/lib\/?/.test(dockerfileContent);
        assert.ok(hasFullProxyCopy || hasLibCopy, 'Dockerfile must copy proxy/ or proxy/lib/ into /usr/local/bin so modular dependencies resolve');
    });

    await t.test('simulates Dockerfile packaging in an isolated directory and verifies auth-proxy starts without MODULE_NOT_FOUND', async () => {
        // Create an isolated temp directory to simulate /usr/local/bin
        const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-docker-pkg-test-'));
        const mockUsrLocalBin = path.join(tempBase, 'usr_local_bin');
        fs.mkdirSync(mockUsrLocalBin, { recursive: true });

        try {
            // Parse COPY instructions from Dockerfile targeting /usr/local/bin/
            const copyLines = dockerfileContent.split('\n').filter(line => line.trim().startsWith('COPY ') && line.includes('/usr/local/bin'));
            assert.ok(copyLines.length > 0, 'Dockerfile should have COPY commands targeting /usr/local/bin');

            for (const line of copyLines) {
                const parts = line.trim().split(/\s+/);
                const src = parts[1]; // e.g. "proxy/", "proxy/auth-proxy.js", "entrypoint.sh"
                const srcPath = path.join(rootDir, src);

                if (fs.existsSync(srcPath)) {
                    const stat = fs.statSync(srcPath);
                    if (stat.isDirectory()) {
                        // Copy directory recursively into mockUsrLocalBin
                        fs.cpSync(srcPath, mockUsrLocalBin, { recursive: true });
                    } else {
                        // Copy individual file
                        fs.copyFileSync(srcPath, path.join(mockUsrLocalBin, path.basename(srcPath)));
                    }
                }
            }

            // Verify auth-proxy.js exists in the simulated /usr/local/bin
            const isolatedProxyScript = path.join(mockUsrLocalBin, 'auth-proxy.js');
            assert.ok(fs.existsSync(isolatedProxyScript), 'auth-proxy.js must exist in simulated /usr/local/bin');

            // Attempt to start auth-proxy.js from the isolated directory
            const TEST_PORT = 17788;
            let stderrOutput = '';
            let stdoutOutput = '';

            const proxyProc = spawn(process.execPath, [isolatedProxyScript], {
                cwd: mockUsrLocalBin,
                env: {
                    ...process.env,
                    AGY_PORT: String(TEST_PORT),
                    AUTH_PASSWORD: '',
                    INITIAL_TARGET_PORT: '0',
                    ENABLE_IDE: 'false',
                    ENABLE_TERMINAL: 'false'
                },
                stdio: ['ignore', 'pipe', 'pipe']
            });

            proxyProc.stdout.on('data', (d) => { stdoutOutput += d.toString(); });
            proxyProc.stderr.on('data', (d) => { stderrOutput += d.toString(); });

            // Wait for proxy to listen or fail
            const started = await new Promise((resolve) => {
                const checkInterval = setInterval(() => {
                    if (stdoutOutput.includes('Listening on') || stdoutOutput.includes('Ready')) {
                        clearInterval(checkInterval);
                        resolve(true);
                    }
                    if (proxyProc.exitCode !== null) {
                        clearInterval(checkInterval);
                        resolve(false);
                    }
                }, 50);

                setTimeout(() => {
                    clearInterval(checkInterval);
                    resolve(false);
                }, 2000);
            });

            // Assert no MODULE_NOT_FOUND errors occurred
            assert.equal(stderrOutput.includes('MODULE_NOT_FOUND'), false, `auth-proxy failed to resolve a module in container layout:\n${stderrOutput}`);
            assert.equal(stderrOutput.includes('Cannot find module'), false, `auth-proxy failed with missing module in container layout:\n${stderrOutput}`);
            assert.ok(started, `auth-proxy should start successfully in simulated container layout. Stderr: ${stderrOutput}`);

            // Verify HTTP status endpoint responds
            const statusRes = await new Promise((resolve, reject) => {
                const req = http.get(`http://127.0.0.1:${TEST_PORT}/status`, (res) => {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => resolve({ status: res.statusCode, body }));
                });
                req.on('error', reject);
            });

            assert.equal(statusRes.status, 200);
            proxyProc.kill('SIGKILL');
        } finally {
            fs.rmSync(tempBase, { recursive: true, force: true });
        }
    });

    await t.test('all internal module require statements resolve within proxy/ directory', () => {
        // Recursively find all .js files in proxy/
        const getJsFiles = (dir) => {
            let results = [];
            const list = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of list) {
                const full = path.join(dir, item.name);
                if (item.isDirectory()) {
                    results = results.concat(getJsFiles(full));
                } else if (item.name.endsWith('.js')) {
                    results.push(full);
                }
            }
            return results;
        };

        const proxyFiles = getJsFiles(path.join(rootDir, 'proxy'));
        for (const filePath of proxyFiles) {
            const content = fs.readFileSync(filePath, 'utf8');
            const requireMatches = content.matchAll(/require\(['"](\.[^'"]+)['"]\)/g);
            for (const match of requireMatches) {
                const reqPath = match[1];
                const dir = path.dirname(filePath);
                
                // Try resolving directly, with .js, or with index.js
                const direct = path.resolve(dir, reqPath);
                const withJs = direct.endsWith('.js') ? direct : `${direct}.js`;
                const withIndex = path.join(direct, 'index.js');

                const exists = fs.existsSync(direct) || fs.existsSync(withJs) || fs.existsSync(withIndex);
                assert.ok(exists, `In ${filePath}: require('${reqPath}') cannot be resolved.`);
            }
        }
    });
});
