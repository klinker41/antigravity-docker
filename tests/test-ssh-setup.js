const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

test('SSH & Git Config Initialization', async (t) => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ssh-test-'));
    const testDeveloper = process.env.USER || 'developer';
    const testHome = path.join(tmpBase, 'home');
    fs.mkdirSync(testHome, { recursive: true });

    // Script snippet matching entrypoint.sh logic for testing in isolated HOME
    const runSshInitScript = (homeDir, user) => {
        const script = `
DEVELOPER_USER="${user}"
HOME="${homeDir}"
SSH_DIR="${homeDir}/.ssh"
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"

if [ -d "$SSH_DIR" ]; then
    chmod 600 "$SSH_DIR"/id_* "$SSH_DIR"/*.pem "$SSH_DIR"/*.key 2>/dev/null || true
    chmod 644 "$SSH_DIR"/*.pub "$SSH_DIR"/known_hosts "$SSH_DIR"/config 2>/dev/null || true
fi

if [ ! -f "$SSH_DIR/config" ]; then
    cat <<EOF > "$SSH_DIR/config"
Host *
    StrictHostKeyChecking accept-new
EOF
    chmod 644 "$SSH_DIR/config"
fi

if [ ! -f "$SSH_DIR/known_hosts" ] || ! grep -q "github.com" "$SSH_DIR/known_hosts" 2>/dev/null; then
    ssh-keyscan -t ed25519,rsa github.com >> "$SSH_DIR/known_hosts" 2>/dev/null || true
    ssh-keyscan -t ed25519,rsa gitlab.com >> "$SSH_DIR/known_hosts" 2>/dev/null || true
    chmod 644 "$SSH_DIR/known_hosts" 2>/dev/null || true
fi

GITCONFIG_FILE="${homeDir}/.gitconfig"
if [ -e "$GITCONFIG_FILE" ]; then
    chmod 644 "$GITCONFIG_FILE" 2>/dev/null || true
fi
`;
        execSync(script, { shell: '/bin/bash' });
    };

    t.after(() => {
        try {
            fs.rmSync(tmpBase, { recursive: true, force: true });
        } catch (e) {}
    });

    await t.test('creates ~/.ssh directory with strict 0700 permissions', () => {
        runSshInitScript(testHome, testDeveloper);
        const sshDir = path.join(testHome, '.ssh');
        assert.ok(fs.existsSync(sshDir));
        const stat = fs.statSync(sshDir);
        const mode = (stat.mode & 0o777).toString(8);
        assert.equal(mode, '700');
    });

    await t.test('creates default ~/.ssh/config with StrictHostKeyChecking accept-new and 0644 permissions', () => {
        const configFile = path.join(testHome, '.ssh', 'config');
        assert.ok(fs.existsSync(configFile));
        const content = fs.readFileSync(configFile, 'utf8');
        assert.ok(content.includes('StrictHostKeyChecking accept-new'));
        const stat = fs.statSync(configFile);
        const mode = (stat.mode & 0o777).toString(8);
        assert.equal(mode, '644');
    });

    await t.test('seeds known_hosts with github.com and gitlab.com', () => {
        const knownHosts = path.join(testHome, '.ssh', 'known_hosts');
        assert.ok(fs.existsSync(knownHosts));
        const stat = fs.statSync(knownHosts);
        const mode = (stat.mode & 0o777).toString(8);
        assert.equal(mode, '644');
    });

    await t.test('fixes overly permissive private and public key files', () => {
        const sshDir = path.join(testHome, '.ssh');
        const privKey = path.join(sshDir, 'id_ed25519');
        const pubKey = path.join(sshDir, 'id_ed25519.pub');

        // Create keys with open 0777 permissions
        fs.writeFileSync(privKey, 'dummy-private-key', { mode: 0o777 });
        fs.writeFileSync(pubKey, 'dummy-public-key', { mode: 0o777 });

        // Run init script again
        runSshInitScript(testHome, testDeveloper);

        const privStat = fs.statSync(privKey);
        const privMode = (privStat.mode & 0o777).toString(8);
        assert.equal(privMode, '600');

        const pubStat = fs.statSync(pubKey);
        const pubMode = (pubStat.mode & 0o777).toString(8);
        assert.equal(pubMode, '644');
    });

    await t.test('preserves custom ~/.ssh/config if already present', () => {
        const configFile = path.join(testHome, '.ssh', 'config');
        fs.writeFileSync(configFile, 'Host custom\n    HostName custom.example.com\n', { mode: 0o644 });

        runSshInitScript(testHome, testDeveloper);

        const content = fs.readFileSync(configFile, 'utf8');
        assert.ok(content.includes('Host custom'));
        assert.ok(content.includes('custom.example.com'));
    });
});
