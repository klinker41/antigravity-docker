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

            // Attempt to start auth-proxy.js from the isolated directory with mock upstream
            const TEST_PORT = 17788;
            const TEST_UPSTREAM_PORT = 17789;
            let stderrOutput = '';
            let stdoutOutput = '';

            const mockUpstream = http.createServer((req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('Mock Upstream OK');
            });
            await new Promise((resolve) => mockUpstream.listen(TEST_UPSTREAM_PORT, '127.0.0.1', resolve));

            const proxyProc = spawn(process.execPath, [isolatedProxyScript], {
                cwd: mockUsrLocalBin,
                env: {
                    ...process.env,
                    AGY_PORT: String(TEST_PORT),
                    AGY_HUB_PORT: String(TEST_UPSTREAM_PORT),
                    AUTH_PASSWORD: '',
                    PORT_FILE: '/tmp/test_pkg_port_nonexistent',
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

            // Verify HTTP status endpoint responds with 200 OK
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
            mockUpstream.close();
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

    await t.test('entrypoint.sh checks for empty projects directory before creating outside-of-project.json', () => {
        const entrypointContent = fs.readFileSync(path.join(rootDir, 'entrypoint.sh'), 'utf8');
        const emptyCheckIdx = entrypointContent.indexOf('ls -A "$GEMINI_DIR/config/projects"');
        const defaultProjCreateIdx = entrypointContent.indexOf('outside-of-project.json');
        assert.ok(emptyCheckIdx !== -1, 'entrypoint.sh should contain fresh container projects check');
        assert.ok(defaultProjCreateIdx !== -1, 'entrypoint.sh should create outside-of-project.json');
        assert.ok(
            emptyCheckIdx < defaultProjCreateIdx,
            'Fresh container /workspace project auto-discovery must run before outside-of-project.json is created'
        );
    });

    await t.test('Dockerfile defines multi-stage slim and full targets with Slim Dev configuration', () => {
        const slimStageMatch = dockerfileContent.match(/FROM\s+\$\{BASE_IMAGE\}\s+AS\s+slim([\s\S]*?)FROM\s+slim\s+AS\s+full([\s\S]*)/);
        assert.ok(slimStageMatch, 'Dockerfile must define FROM ${BASE_IMAGE} AS slim followed by FROM slim AS full');

        const slimStage = slimStageMatch[1]
            .split('\n')
            .filter(line => !line.trim().startsWith('#'))
            .join('\n');
        const fullStage = slimStageMatch[2]
            .split('\n')
            .filter(line => !line.trim().startsWith('#'))
            .join('\n');

        // Slim stage must include core runtimes (nodejs, bun, python3, uv, agy)
        assert.match(slimStage, /nodejs/, 'slim stage should install nodejs');
        assert.match(slimStage, /npm install -g bun/, 'slim stage should install bun');
        assert.match(slimStage, /python3/, 'slim stage should install python3');
        assert.match(slimStage, /astral\.sh\/uv\/install\.sh/, 'slim stage should install standalone uv');
        assert.match(slimStage, /antigravity\.google\/cli\/install\.sh/, 'slim stage should install agy CLI');

        // Slim stage must default ENABLE_IDE and ENABLE_TERMINAL to false
        assert.match(slimStage, /ENABLE_IDE="false"/, 'slim stage must default ENABLE_IDE to false');
        assert.match(slimStage, /ENABLE_TERMINAL="false"/, 'slim stage must default ENABLE_TERMINAL to false');

        // Slim stage must NOT include IDE, terminal, C/C++ build toolchain, interactive editors/shells, or redundant package managers
        for (const excluded of [
            'code-server',
            'ttyd',
            'host-terminal.sh',
            'build-essential',
            'libssl-dev',
            'libffi-dev',
            'python3-dev',
            'python3-pip',
            'poetry',
            'pipenv',
            'virtualenv',
            'npm install -g pnpm',
            'yarn',
            'vim',
            'nano',
            'zsh',
            'tmux'
        ]) {
            assert.equal(
                slimStage.includes(excluded),
                false,
                `slim stage must not include "${excluded}"`
            );
        }

        // Full stage must restore IDE, terminal, build-essential, and default ENABLE_IDE/ENABLE_TERMINAL to true
        assert.match(fullStage, /code-server\.dev\/install\.sh/, 'full stage should install code-server');
        assert.match(fullStage, /ttyd/, 'full stage should install ttyd');
        assert.match(fullStage, /build-essential/, 'full stage should install build-essential');
        assert.match(fullStage, /poetry pipenv virtualenv/, 'full stage should install poetry, pipenv, virtualenv');
        assert.match(fullStage, /npm install -g pnpm yarn/, 'full stage should install pnpm and yarn');
        assert.match(fullStage, /ENABLE_IDE="true"/, 'full stage should default ENABLE_IDE to true');
        assert.match(fullStage, /ENABLE_TERMINAL="true"/, 'full stage should default ENABLE_TERMINAL to true');
    });

    await t.test('entrypoint.sh gracefully disables ENABLE_IDE and ENABLE_TERMINAL when binaries are absent in slim image', () => {
        const entrypointContent = fs.readFileSync(path.join(rootDir, 'entrypoint.sh'), 'utf8');
        assert.match(entrypointContent, /command -v code-server/, 'entrypoint.sh should check if code-server binary exists');
        assert.match(entrypointContent, /command -v ttyd/, 'entrypoint.sh should check if ttyd binary exists');

        // Extract the daemon IDE/Terminal startup block and run it in a clean subshell without code-server/ttyd in PATH
        const startMarker = 'ENABLE_IDE="${ENABLE_IDE:-true}"';
        const endMarker = 'export AGY_PORT="${TARGET_PORT}"';
        const startIdx = entrypointContent.indexOf(startMarker);
        const endIdx = entrypointContent.indexOf(endMarker);
        assert.ok(startIdx !== -1 && endIdx !== -1 && startIdx < endIdx, 'Could not locate IDE/Terminal block in entrypoint.sh');

        const block = entrypointContent.slice(startIdx, endIdx);
        const { execFileSync } = require('node:child_process');
        const output = execFileSync('/bin/bash', ['-c', `
            export PATH=""
            export ENABLE_IDE="true"
            export ENABLE_TERMINAL="true"
            ${block}
            echo "FINAL_IDE=$ENABLE_IDE"
            echo "FINAL_TERMINAL=$ENABLE_TERMINAL"
        `], { encoding: 'utf8' });

        assert.match(output, /FINAL_IDE=false/, 'ENABLE_IDE should be forced to false when code-server is not in PATH');
        assert.match(output, /FINAL_TERMINAL=false/, 'ENABLE_TERMINAL should be forced to false when ttyd is not in PATH');
    });
});
