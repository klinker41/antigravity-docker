const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const EventEmitter = require('node:events');

const HOME_DIR = process.env.HOME || '/home/developer';
const GEMINI_CONFIG_DIR = process.env.GEMINI_CONFIG_DIR || path.join(HOME_DIR, '.gemini/config');
const SIDECARS_DIR = path.join(GEMINI_CONFIG_DIR, 'sidecars');
const PLUGINS_DIR = path.join(GEMINI_CONFIG_DIR, 'plugins');
const CONFIG_FILE = path.join(GEMINI_CONFIG_DIR, 'config.json');
const PROJECTS_DIR = path.join(GEMINI_CONFIG_DIR, 'projects');
const RUNTIME_DATA_DIR = process.env.GEMINI_RUNTIME_DIR || path.join(HOME_DIR, '.gemini/antigravity/sidecar_data');
const AGY_BIN_DIR = path.join(HOME_DIR, '.gemini/antigravity-cli/bin');
const LOCAL_BIN_DIR = path.join(HOME_DIR, '.local/bin');

/**
 * Parses a single field in a 5-field cron expression.
 * Returns a Set of allowed integer values within [min, max].
 */
function parseCronField(field, min, max) {
    const allowed = new Set();
    const parts = field.split(',');

    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        // Step notation (e.g. */5, 1-30/2)
        if (trimmed.includes('/')) {
            const [rangePart, stepStr] = trimmed.split('/');
            const step = parseInt(stepStr, 10);
            if (isNaN(step) || step <= 0) continue;

            let start = min;
            let end = max;
            if (rangePart !== '*') {
                if (rangePart.includes('-')) {
                    const [rStart, rEnd] = rangePart.split('-').map(n => parseInt(n, 10));
                    if (!isNaN(rStart)) start = Math.max(min, rStart);
                    if (!isNaN(rEnd)) end = Math.min(max, rEnd);
                } else {
                    const parsedStart = parseInt(rangePart, 10);
                    if (!isNaN(parsedStart)) start = Math.max(min, parsedStart);
                }
            }

            for (let i = start; i <= end; i += step) {
                allowed.add(i);
            }
        } else if (trimmed.includes('-')) {
            // Range notation (e.g. 1-5)
            const [startStr, endStr] = trimmed.split('-');
            const start = parseInt(startStr, 10);
            const end = parseInt(endStr, 10);
            if (!isNaN(start) && !isNaN(end)) {
                for (let i = Math.max(min, start); i <= Math.min(max, end); i++) {
                    allowed.add(i);
                }
            }
        } else if (trimmed === '*') {
            for (let i = min; i <= max; i++) {
                allowed.add(i);
            }
        } else {
            const val = parseInt(trimmed, 10);
            if (!isNaN(val) && val >= min && val <= max) {
                allowed.add(val);
            }
        }
    }

    return allowed;
}

/**
 * Validates and matches a 5-field cron expression against a given Date.
 */
function matchesCron(cronExpr, date = new Date()) {
    if (!cronExpr || typeof cronExpr !== 'string') return false;
    const fields = cronExpr.trim().split(/\s+/);
    if (fields.length !== 5) return false;

    try {
        const allowedMinutes = parseCronField(fields[0], 0, 59);
        const allowedHours = parseCronField(fields[1], 0, 23);
        const allowedDaysOfMonth = parseCronField(fields[2], 1, 31);
        const allowedMonths = parseCronField(fields[3], 1, 12);
        const allowedDaysOfWeek = parseCronField(fields[4], 0, 7); // 0 & 7 = Sunday

        const m = date.getMinutes();
        const h = date.getHours();
        const dom = date.getDate();
        const mon = date.getMonth() + 1;
        let dow = date.getDay(); // 0-6

        if (!allowedMinutes.has(m)) return false;
        if (!allowedHours.has(h)) return false;
        if (!allowedDaysOfMonth.has(dom)) return false;
        if (!allowedMonths.has(mon)) return false;
        if (!allowedDaysOfWeek.has(dow) && !(dow === 0 && allowedDaysOfWeek.has(7))) return false;

        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Returns human-friendly explanation of standard cron expressions.
 */
function describeCron(cronExpr) {
    if (!cronExpr || typeof cronExpr !== 'string') return '';
    const fields = cronExpr.trim().split(/\s+/);
    if (fields.length !== 5) return cronExpr;

    const [m, h, dom, mon, dow] = fields;
    if (cronExpr === '* * * * *') return 'Every minute';
    if (cronExpr.startsWith('*/') && h === '*' && dom === '*' && mon === '*' && dow === '*') {
        return `Every ${m.replace('*/', '')} minutes`;
    }
    if (m === '0' && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour, on the hour';
    if (m === '0' && h.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
        return `Every ${h.replace('*/', '')} hours`;
    }
    if (dom === '*' && mon === '*' && dow === '*' && !m.includes('*') && !h.includes('*')) {
        const hh = h.padStart(2, '0');
        const mm = m.padStart(2, '0');
        return `Daily at ${hh}:${mm}`;
    }
    if (dom === '*' && mon === '*' && dow === '1-5' && !m.includes('*') && !h.includes('*')) {
        const hh = h.padStart(2, '0');
        const mm = m.padStart(2, '0');
        return `Every weekday at ${hh}:${mm}`;
    }
    return `Cron: ${cronExpr}`;
}

/**
 * Calculates the next upcoming execution time for a cron expression.
 */
function getNextCronRun(cronExpr, fromDate = new Date()) {
    if (!cronExpr) return null;
    const date = new Date(fromDate.getTime());
    date.setSeconds(0, 0);
    date.setMinutes(date.getMinutes() + 1); // Check from next minute

    // Scan up to 45 days into the future
    const maxMinutes = 45 * 24 * 60;
    for (let i = 0; i < maxMinutes; i++) {
        if (matchesCron(cronExpr, date)) {
            return date.toISOString();
        }
        date.setMinutes(date.getMinutes() + 1);
    }
    return null;
}

class SidecarManager extends EventEmitter {
    constructor() {
        super();
        this.runningWorkers = new Map(); // id -> { process, startedAt, restartCount, timer }
        this.scheduledJobs = new Map();  // id -> { cronExpr, lastRun, nextRun, lastResult }
        this.schedulerInterval = null;
        this.lastCheckedMinute = -1;
        this.lsAddress = null;
        this.csrfToken = null;
    }

    setLsAddress(address) {
        if (address && typeof address === 'string') {
            const clean = address.replace(/^https?:\/\//, '');
            this.lsAddress = clean;
            process.env.ANTIGRAVITY_LS_ADDRESS = clean;
        }
    }

    setCsrfToken(token) {
        if (token && typeof token === 'string') {
            this.csrfToken = token.trim();
            process.env.ANTIGRAVITY_CSRF_TOKEN = this.csrfToken;
            try {
                fs.writeFileSync('/tmp/antigravity_csrf_token', this.csrfToken, 'utf8');
            } catch (e) {}
        }
    }

    getLsAddress() {
        if (this.lsAddress) return this.lsAddress;
        if (process.env.ANTIGRAVITY_LS_ADDRESS) return process.env.ANTIGRAVITY_LS_ADDRESS;

        // Check /tmp/antigravity_ls_address
        const lsFile = '/tmp/antigravity_ls_address';
        if (fs.existsSync(lsFile)) {
            try {
                const addr = fs.readFileSync(lsFile, 'utf8').trim();
                if (addr) {
                    this.lsAddress = addr;
                    return addr;
                }
            } catch (e) {}
        }

        // Check /tmp/antigravity_port
        const portFile = process.env.PORT_FILE || '/tmp/antigravity_port';
        if (fs.existsSync(portFile)) {
            try {
                const port = fs.readFileSync(portFile, 'utf8').trim();
                if (port && /^\d+$/.test(port)) {
                    const addr = `127.0.0.1:${port}`;
                    this.lsAddress = addr;
                    return addr;
                }
            } catch (e) {}
        }

        // Check cli.log or /tmp/cli.log
        const possibleLogs = [
            path.join(HOME_DIR, '.gemini/antigravity-cli/cli.log'),
            '/tmp/cli.log'
        ];
        for (const logPath of possibleLogs) {
            if (fs.existsSync(logPath)) {
                try {
                    const content = fs.readFileSync(logPath, 'utf8').slice(0, 8192);
                    const match = content.match(/listening on random port at (\d+) for HTTP\s*$/m) ||
                                  content.match(/(?:http:\/\/localhost:|http:\/\/127\.0\.0\.1:)(\d+)/i);
                    if (match && match[1]) {
                        const addr = `127.0.0.1:${match[1]}`;
                        this.lsAddress = addr;
                        return addr;
                    }
                } catch (e) {}
            }
        }

        return '';
    }

    async getCsrfToken() {
        if (this.csrfToken) return this.csrfToken;
        if (process.env.ANTIGRAVITY_CSRF_TOKEN) return process.env.ANTIGRAVITY_CSRF_TOKEN;

        // Check /tmp/antigravity_csrf_token
        const csrfFile = '/tmp/antigravity_csrf_token';
        if (fs.existsSync(csrfFile)) {
            try {
                const token = fs.readFileSync(csrfFile, 'utf8').trim();
                if (token) {
                    this.csrfToken = token;
                    return token;
                }
            } catch (e) {}
        }

        const lsAddress = this.getLsAddress();
        if (lsAddress) {
            const token = await this.fetchCsrfFromAddress(lsAddress);
            if (token) {
                this.setCsrfToken(token);
                return token;
            }
        }

        return '';
    }

    fetchCsrfFromAddress(lsAddress) {
        return new Promise((resolve) => {
            if (!lsAddress) return resolve('');
            const [host, port] = lsAddress.split(':');
            const req = http.request({
                hostname: host || '127.0.0.1',
                port: parseInt(port, 10),
                path: '/',
                method: 'GET',
                timeout: 2000
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    const match = body.match(/"csrfToken":"([^"]+)"/);
                    resolve(match ? match[1] : '');
                });
            });
            req.on('error', () => resolve(''));
            req.on('timeout', () => { req.destroy(); resolve(''); });
            req.end();
        });
    }

    /**
     * Initializes directories and starts all enabled sidecars.
     */
    async init() {
        this.ensureDirectories();
        console.log('[Sidecar Manager] 🚀 Initializing Sidecar Manager subsystem...');
        await this.reload();

        // Start 1-minute ticker for cron scheduler
        if (!this.schedulerInterval) {
            this.schedulerInterval = setInterval(() => {
                this.tickScheduler();
            }, 1000);
        }
        console.log('[Sidecar Manager] ⏱️  Cron scheduler engine active.');
    }

    ensureDirectories() {
        try {
            fs.mkdirSync(SIDECARS_DIR, { recursive: true });
            fs.mkdirSync(PROJECTS_DIR, { recursive: true });
            fs.mkdirSync(RUNTIME_DATA_DIR, { recursive: true });
        } catch (e) {}
    }

    /**
     * Reads global config.json sidecars section.
     */
    readConfig() {
        try {
            if (fs.existsSync(CONFIG_FILE)) {
                const content = fs.readFileSync(CONFIG_FILE, 'utf8');
                return JSON.parse(content);
            }
        } catch (e) {
            console.error('[Sidecar Manager] Error reading config.json:', e.message);
        }
        return {};
    }

    /**
     * Writes to global config.json preserving existing settings.
     */
    writeConfig(configData) {
        try {
            this.ensureDirectories();
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
        } catch (e) {
            console.error('[Sidecar Manager] Error writing config.json:', e.message);
            throw e;
        }
    }

    /**
     * Gets registered projects from ~/.gemini/config/projects/
     */
    listProjects() {
        const projects = [];
        try {
            if (fs.existsSync(PROJECTS_DIR)) {
                const files = fs.readdirSync(PROJECTS_DIR);
                for (const file of files) {
                    if (file.endsWith('.json') && file !== '.json') {
                        try {
                            const pPath = path.join(PROJECTS_DIR, file);
                            const content = fs.readFileSync(pPath, 'utf8');
                            const proj = JSON.parse(content);
                            projects.push({
                                id: proj.id || file.replace('.json', ''),
                                name: proj.name || file.replace('.json', ''),
                                isWorkspaceOnly: Boolean(proj.isWorkspaceOnly)
                            });
                        } catch (e) {}
                    }
                }
            }
        } catch (e) {}

        if (!projects.some(p => p.id === 'outside-of-project')) {
            projects.unshift({
                id: 'outside-of-project',
                name: 'Outside of Project',
                isWorkspaceOnly: false
            });
        }

        return projects;
    }

    /**
     * Discovers all sidecars from ~/.gemini/config/sidecars and plugins.
     */
    listSidecars() {
        this.ensureDirectories();
        const sidecars = [];
        const config = this.readConfig();
        const sidecarsConfig = config.sidecars || {};

        // 1. Scan global sidecars (~/.gemini/config/sidecars/<id>/sidecar.json)
        try {
            if (fs.existsSync(SIDECARS_DIR)) {
                const entries = fs.readdirSync(SIDECARS_DIR, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const id = entry.name;
                        const sidecarJsonPath = path.join(SIDECARS_DIR, id, 'sidecar.json');
                        if (fs.existsSync(sidecarJsonPath)) {
                            try {
                                const parsed = JSON.parse(fs.readFileSync(sidecarJsonPath, 'utf8'));
                                const userConf = sidecarsConfig[id] || {};
                                const isEnabled = Boolean(userConf.enabled !== undefined ? userConf.enabled : parsed.enabled);
                                const projectId = userConf.projectId || parsed.projectId || '';

                                sidecars.push(this.formatSidecarInfo(id, parsed, isEnabled, projectId, false));
                            } catch (e) {
                                console.error(`[Sidecar Manager] Failed parsing ${sidecarJsonPath}:`, e.message);
                            }
                        }
                    }
                }
            }
        } catch (e) {}

        // 2. Scan plugin sidecars (~/.gemini/config/plugins/<plugin>/sidecars/<name>/sidecar.json)
        try {
            if (fs.existsSync(PLUGINS_DIR)) {
                const pluginEntries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
                for (const pluginEntry of pluginEntries) {
                    if (pluginEntry.isDirectory()) {
                        const pluginName = pluginEntry.name;
                        const pluginSidecarsDir = path.join(PLUGINS_DIR, pluginName, 'sidecars');
                        if (fs.existsSync(pluginSidecarsDir)) {
                            const subEntries = fs.readdirSync(pluginSidecarsDir, { withFileTypes: true });
                            for (const sub of subEntries) {
                                if (sub.isDirectory()) {
                                    const sidecarName = sub.name;
                                    const id = `${pluginName}/${sidecarName}`;
                                    const sidecarJsonPath = path.join(pluginSidecarsDir, sidecarName, 'sidecar.json');
                                    if (fs.existsSync(sidecarJsonPath)) {
                                        try {
                                            const parsed = JSON.parse(fs.readFileSync(sidecarJsonPath, 'utf8'));
                                            const userConf = sidecarsConfig[id] || {};
                                            const isEnabled = Boolean(userConf.enabled !== undefined ? userConf.enabled : parsed.enabled);
                                            const projectId = userConf.projectId || parsed.projectId || '';

                                            sidecars.push(this.formatSidecarInfo(id, parsed, isEnabled, projectId, true));
                                        } catch (e) {}
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) {}

        return sidecars;
    }

    formatSidecarInfo(id, parsed, isEnabled, projectId, isPlugin = false) {
        const isScheduled = parsed.builtin === 'schedule';
        const cronExpr = isScheduled && Array.isArray(parsed.args) ? parsed.args[0] : '';
        const workerInfo = this.runningWorkers.get(id);
        const scheduledInfo = this.scheduledJobs.get(id);

        let status = 'stopped';
        if (isEnabled) {
            if (isScheduled) {
                status = 'scheduled';
            } else if (workerInfo && workerInfo.process && !workerInfo.process.killed) {
                status = 'running';
            } else {
                status = 'starting';
            }
        }

        return {
            id,
            displayName: parsed.display_name || id,
            description: parsed.description || '',
            command: parsed.command || '',
            builtin: parsed.builtin || '',
            args: parsed.args || [],
            restartPolicy: parsed.restart_policy || 'always',
            env: parsed.env || {},
            enabled: isEnabled,
            projectId: projectId || '',
            isPlugin,
            isScheduled,
            cronExpr,
            cronDescription: isScheduled ? describeCron(cronExpr) : '',
            status,
            pid: workerInfo?.process?.pid || null,
            startedAt: workerInfo?.startedAt || null,
            lastRun: scheduledInfo?.lastRun || null,
            nextRun: isScheduled && isEnabled ? getNextCronRun(cronExpr) : null,
            restartCount: workerInfo?.restartCount || 0
        };
    }

    getSidecar(id) {
        const all = this.listSidecars();
        return all.find(s => s.id === id) || null;
    }

    /**
     * Saves or creates a sidecar definition in ~/.gemini/config/sidecars/<id>/sidecar.json
     * and updates ~/.gemini/config/config.json with enabled state and projectId.
     */
    async saveSidecar(data) {
        if (!data || !data.id) throw new Error('Sidecar ID is required.');
        const rawId = String(data.id).trim();
        const id = rawId.replace(/[^a-zA-Z0-9_\-\/]/g, '-');

        const dirPath = path.join(SIDECARS_DIR, id);
        fs.mkdirSync(dirPath, { recursive: true });

        const sidecarJson = {
            display_name: data.displayName || data.display_name || id,
            description: data.description || '',
            restart_policy: data.restartPolicy || data.restart_policy || 'always'
        };

        if (data.builtin) {
            sidecarJson.builtin = data.builtin;
        } else if (data.command) {
            sidecarJson.command = data.command;
        } else if (data.isScheduled) {
            sidecarJson.builtin = 'schedule';
        } else {
            throw new Error('Either command or builtin must be specified.');
        }

        if (Array.isArray(data.args)) {
            sidecarJson.args = data.args;
        } else if (typeof data.args === 'string') {
            sidecarJson.args = data.args.split('\n').map(s => s.trim()).filter(Boolean);
        } else {
            sidecarJson.args = [];
        }

        if (data.env && typeof data.env === 'object') {
            sidecarJson.env = data.env;
        }

        const sidecarFilePath = path.join(dirPath, 'sidecar.json');
        fs.writeFileSync(sidecarFilePath, JSON.stringify(sidecarJson, null, 2), 'utf8');

        // Update config.json
        const config = this.readConfig();
        if (!config.sidecars) config.sidecars = {};
        const enabled = Boolean(data.enabled !== undefined ? data.enabled : true);
        config.sidecars[id] = {
            enabled,
            projectId: data.projectId || ''
        };
        this.writeConfig(config);

        console.log(`[Sidecar Manager] 💾 Saved sidecar definition '${id}' (Enabled: ${enabled})`);
        await this.syncSidecarState(id);
        return this.getSidecar(id);
    }

    /**
     * Toggles a sidecar's enabled state in config.json.
     */
    async toggleSidecar(id, enabled) {
        const config = this.readConfig();
        if (!config.sidecars) config.sidecars = {};
        if (!config.sidecars[id]) config.sidecars[id] = {};

        config.sidecars[id].enabled = Boolean(enabled);
        this.writeConfig(config);

        console.log(`[Sidecar Manager] 🔄 Toggled sidecar '${id}' -> ${enabled ? 'ENABLED' : 'DISABLED'}`);
        await this.syncSidecarState(id);
        return this.getSidecar(id);
    }

    /**
     * Deletes a sidecar directory and removes it from config.json.
     */
    async deleteSidecar(id) {
        this.stopSidecar(id);

        const config = this.readConfig();
        if (config.sidecars && config.sidecars[id]) {
            delete config.sidecars[id];
            this.writeConfig(config);
        }

        const dirPath = path.join(SIDECARS_DIR, id);
        if (fs.existsSync(dirPath)) {
            try {
                fs.rmSync(dirPath, { recursive: true, force: true });
            } catch (e) {
                console.error(`[Sidecar Manager] Error deleting folder ${dirPath}:`, e.message);
            }
        }

        console.log(`[Sidecar Manager] 🗑️  Deleted sidecar '${id}'`);
        return true;
    }

    /**
     * Reloads all sidecars and synchronizes their running states.
     */
    async reload() {
        const sidecars = this.listSidecars();
        console.log(`[Sidecar Manager] 📦 Discovered ${sidecars.length} sidecar(s) in configuration.`);

        // Stop any running sidecar that is no longer found
        const foundIds = new Set(sidecars.map(s => s.id));
        for (const [id] of this.runningWorkers) {
            if (!foundIds.has(id)) {
                this.stopSidecar(id);
            }
        }
        for (const [id] of this.scheduledJobs) {
            if (!foundIds.has(id)) {
                this.scheduledJobs.delete(id);
            }
        }

        for (const sidecar of sidecars) {
            await this.syncSidecarState(sidecar.id);
        }
    }

    /**
     * Synchronizes a specific sidecar's running state with its configuration.
     */
    async syncSidecarState(id) {
        const sidecar = this.getSidecar(id);
        if (!sidecar) {
            this.stopSidecar(id);
            return;
        }

        if (!sidecar.enabled) {
            this.stopSidecar(id);
            return;
        }

        if (sidecar.isScheduled) {
            // Register or update schedule
            this.stopWorker(id);
            this.scheduledJobs.set(id, {
                cronExpr: sidecar.cronExpr,
                lastRun: null,
                nextRun: getNextCronRun(sidecar.cronExpr)
            });
            console.log(`[Sidecar Manager] ⏰ Scheduled sidecar '${id}' [${sidecar.cronDescription}]`);
        } else {
            // Continuous worker
            this.scheduledJobs.delete(id);
            if (!this.runningWorkers.has(id) || !this.runningWorkers.get(id).process) {
                this.startWorker(sidecar);
            }
        }
    }

    /**
     * Starts a continuous background worker process.
     */
    async startWorker(sidecar) {
        if (!sidecar || !sidecar.command) return;
        const id = sidecar.id;
        this.stopWorker(id);

        const sidecarDir = path.join(SIDECARS_DIR, id);
        const dataDir = path.join(RUNTIME_DATA_DIR, id, 'data');
        const logsDir = path.join(RUNTIME_DATA_DIR, id, 'logs');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(logsDir, { recursive: true });

        const logFile = path.join(logsDir, 'worker.log');
        const logStream = fs.createWriteStream(logFile, { flags: 'a' });

        const lsAddress = this.getLsAddress();
        const csrfToken = await this.getCsrfToken();
        const env = {
            ...process.env,
            ...sidecar.env,
            HOME: HOME_DIR,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
            ANTIGRAVITY_AGENTAPI_EXE: path.join(LOCAL_BIN_DIR, 'agy'),
            PATH: `${AGY_BIN_DIR}:${LOCAL_BIN_DIR}:${process.env.PATH || ''}`
        };
        if (lsAddress && !env.ANTIGRAVITY_LS_ADDRESS) {
            env.ANTIGRAVITY_LS_ADDRESS = lsAddress;
        }
        if (csrfToken && !env.ANTIGRAVITY_CSRF_TOKEN) {
            env.ANTIGRAVITY_CSRF_TOKEN = csrfToken;
        }
        if (sidecar.projectId) {
            env.PROJECT_ID = sidecar.projectId;
            env.AGY_PROJECT_ID = sidecar.projectId;
            env.ANTIGRAVITY_PROJECT_ID = sidecar.projectId;
        }

        console.log(`[Sidecar Manager] 🚀 Starting worker '${id}': ${sidecar.command} ${(sidecar.args || []).join(' ')}`);

        try {
            const child = spawn(sidecar.command, sidecar.args || [], {
                cwd: fs.existsSync(sidecarDir) ? sidecarDir : HOME_DIR,
                env,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            const workerEntry = {
                process: child,
                startedAt: new Date().toISOString(),
                restartCount: (this.runningWorkers.get(id)?.restartCount || 0),
                timer: null
            };
            this.runningWorkers.set(id, workerEntry);

            child.stdout.on('data', (chunk) => {
                const text = chunk.toString();
                logStream.write(`[${new Date().toISOString()}] [STDOUT] ${text}`);
            });

            child.stderr.on('data', (chunk) => {
                const text = chunk.toString();
                logStream.write(`[${new Date().toISOString()}] [STDERR] ${text}`);
            });

            child.on('error', (err) => {
                console.error(`[Sidecar Manager] ❌ Error in worker '${id}':`, err.message);
                logStream.write(`[${new Date().toISOString()}] [ERROR] ${err.message}\n`);
            });

            child.on('close', (code, signal) => {
                logStream.end();
                console.log(`[Sidecar Manager] ⚠️ Worker '${id}' exited (Code: ${code}, Signal: ${signal})`);
                this.runningWorkers.delete(id);

                const currentSidecar = this.getSidecar(id);
                if (currentSidecar && currentSidecar.enabled) {
                    const policy = currentSidecar.restartPolicy || 'always';
                    const shouldRestart = (policy === 'always') || (policy === 'on-failure' && code !== 0);

                    if (shouldRestart) {
                        console.log(`[Sidecar Manager] 🔁 Restarting worker '${id}' in 3s (Policy: ${policy})...`);
                        const timer = setTimeout(() => {
                            const latest = this.getSidecar(id);
                            if (latest && latest.enabled && !latest.isScheduled) {
                                workerEntry.restartCount += 1;
                                this.startWorker(latest);
                            }
                        }, 3000);
                        this.runningWorkers.set(id, { ...workerEntry, process: null, timer });
                    }
                }
            });
        } catch (e) {
            console.error(`[Sidecar Manager] Failed to spawn worker '${id}':`, e.message);
        }
    }

    /**
     * Stops a running worker process.
     */
    stopWorker(id) {
        const worker = this.runningWorkers.get(id);
        if (worker) {
            if (worker.timer) clearTimeout(worker.timer);
            if (worker.process && !worker.process.killed) {
                try {
                    worker.process.kill('SIGTERM');
                    setTimeout(() => {
                        if (worker.process && !worker.process.killed) {
                            try { worker.process.kill('SIGKILL'); } catch (e) {}
                        }
                    }, 2000);
                } catch (e) {}
            }
            this.runningWorkers.delete(id);
            console.log(`[Sidecar Manager] ⏹️  Stopped worker '${id}'`);
        }
    }

    /**
     * Stops any worker or scheduled job for a sidecar.
     */
    stopSidecar(id) {
        this.stopWorker(id);
        this.scheduledJobs.delete(id);
    }

    /**
     * Minute tick evaluator for cron schedules.
     */
    tickScheduler() {
        const now = new Date();
        const currentMinute = now.getMinutes();
        if (currentMinute === this.lastCheckedMinute) return;
        this.lastCheckedMinute = currentMinute;

        for (const [id, jobInfo] of this.scheduledJobs.entries()) {
            const sidecar = this.getSidecar(id);
            if (!sidecar || !sidecar.enabled || !sidecar.isScheduled) {
                this.scheduledJobs.delete(id);
                continue;
            }

            if (matchesCron(sidecar.cronExpr, now)) {
                this.executeScheduledJob(sidecar);
            }
        }
    }

    /**
     * Executes a scheduled sidecar task (command or agentapi prompt).
     */
    async executeScheduledJob(sidecar) {
        const id = sidecar.id;
        const args = sidecar.args || [];
        if (args.length < 2) {
            console.warn(`[Sidecar Manager] ⚠️ Scheduled sidecar '${id}' has insufficient arguments:`, args);
            return;
        }

        const execCommand = args[1];
        const execArgs = args.slice(2);
        const sidecarDir = path.join(SIDECARS_DIR, id);
        const dataDir = path.join(RUNTIME_DATA_DIR, id, 'data');
        const logsDir = path.join(RUNTIME_DATA_DIR, id, 'logs');
        const eventsDir = path.join(RUNTIME_DATA_DIR, id, 'events');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(logsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logFile = path.join(logsDir, `${timestamp}.log`);
        const latestLogFile = path.join(logsDir, 'latest.log');
        const logStream = fs.createWriteStream(logFile, { flags: 'w' });

        const lsAddress = this.getLsAddress();
        const csrfToken = await this.getCsrfToken();
        const env = {
            ...process.env,
            ...sidecar.env,
            HOME: HOME_DIR,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
            ANTIGRAVITY_AGENTAPI_EXE: path.join(LOCAL_BIN_DIR, 'agy'),
            PATH: `${AGY_BIN_DIR}:${LOCAL_BIN_DIR}:${process.env.PATH || ''}`
        };
        if (lsAddress && !env.ANTIGRAVITY_LS_ADDRESS) {
            env.ANTIGRAVITY_LS_ADDRESS = lsAddress;
        }
        if (csrfToken && !env.ANTIGRAVITY_CSRF_TOKEN) {
            env.ANTIGRAVITY_CSRF_TOKEN = csrfToken;
        }
        if (sidecar.projectId) {
            env.PROJECT_ID = sidecar.projectId;
            env.AGY_PROJECT_ID = sidecar.projectId;
            env.ANTIGRAVITY_PROJECT_ID = sidecar.projectId;
        }

        // Special logging if agentapi prompt is fired
        if (execCommand === 'agentapi' && execArgs[0] === 'new-conversation') {
            const prompt = execArgs[execArgs.length - 1];
            console.log(`[Sidecar Manager] 💬 Firing agentapi prompt for '${id}' [Project: ${sidecar.projectId || 'default'}]: "${prompt}"`);
        } else {
            console.log(`[Sidecar Manager] ⏰ Firing scheduled command for '${id}': ${execCommand} ${execArgs.join(' ')}`);
        }

        try {
            const child = spawn(execCommand, execArgs, {
                cwd: fs.existsSync(sidecarDir) ? sidecarDir : HOME_DIR,
                env,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            const scheduledEntry = this.scheduledJobs.get(id) || {};
            scheduledEntry.lastRun = new Date().toISOString();
            this.scheduledJobs.set(id, scheduledEntry);

            child.stdout.on('data', (chunk) => {
                const text = chunk.toString();
                logStream.write(`[STDOUT] ${text}`);
            });

            child.stderr.on('data', (chunk) => {
                const text = chunk.toString();
                logStream.write(`[STDERR] ${text}`);
            });

            child.on('close', (code) => {
                logStream.end();
                try {
                    fs.copyFileSync(logFile, latestLogFile);
                } catch (e) {}
                console.log(`[Sidecar Manager] ✅ Scheduled execution for '${id}' completed (Exit Code: ${code})`);
            });

            child.on('error', (err) => {
                console.error(`[Sidecar Manager] ❌ Error executing scheduled sidecar '${id}':`, err.message);
                logStream.write(`[ERROR] ${err.message}\n`);
                logStream.end();
            });
        } catch (e) {
            console.error(`[Sidecar Manager] Failed to execute scheduled sidecar '${id}':`, e.message);
        }
    }

    /**
     * Manually triggers an immediate execution of a sidecar.
     */
    async triggerSidecar(id) {
        const sidecar = this.getSidecar(id);
        if (!sidecar) throw new Error(`Sidecar '${id}' not found.`);

        console.log(`[Sidecar Manager] ⚡ Manual trigger requested for '${id}'`);
        if (sidecar.isScheduled) {
            await this.executeScheduledJob(sidecar);
            return { message: `Triggered scheduled job for '${id}'` };
        } else {
            this.startWorker(sidecar);
            return { message: `Restarted worker '${id}'` };
        }
    }

    /**
     * Reads recent log entries for a sidecar.
     */
    getLogs(id) {
        const logsDir = path.join(RUNTIME_DATA_DIR, id, 'logs');
        if (!fs.existsSync(logsDir)) return 'No logs recorded yet.';

        try {
            const files = fs.readdirSync(logsDir)
                .filter(f => f.endsWith('.log'))
                .sort()
                .reverse();

            if (files.length === 0) return 'No logs recorded yet.';

            const targetFile = files.includes('latest.log') ? 'latest.log' : (files.includes('worker.log') ? 'worker.log' : files[0]);
            const fullPath = path.join(logsDir, targetFile);
            const content = fs.readFileSync(fullPath, 'utf8');
            return content.slice(-16384) || 'Log file is empty.';
        } catch (e) {
            return `Error reading logs: ${e.message}`;
        }
    }
}

const instance = new SidecarManager();
instance.parseCronField = parseCronField;
instance.matchesCron = matchesCron;
instance.describeCron = describeCron;
instance.getNextCronRun = getNextCronRun;

module.exports = instance;
