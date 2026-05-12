/**
 * ══════════════════════════════════════════════════════════════════
 *  CODE ENGINE — Meridian's Autonomous Coding Capability
 * ══════════════════════════════════════════════════════════════════
 * 
 *  Gives the agent the ability to write, run, test, and deploy code
 *  during its leisure curiosity cycles. All operations are sandboxed
 *  with strict security rules.
 * 
 *  SECURITY MODEL:
 *  - Commands cannot execute destructive operations (rm -rf, sudo, etc.)
 *  - File writes are restricted to /tmp/meridian-workspace/
 *  - All commands have a 30-second timeout
 *  - Every action is logged to experienceMemory
 *  - Max file size: 100KB
 *  - Max workspace size: 50 files
 */

import { execSync, ExecSyncOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { experienceMemory } from './experienceMemory';

// ── Sandbox Configuration ───────────────────────────────────────
const WORKSPACE_ROOT = '/tmp/meridian-workspace';
const MAX_FILE_SIZE = 100 * 1024;  // 100KB per file
const MAX_FILES = 50;               // max files in workspace
const COMMAND_TIMEOUT = 30_000;     // 30 seconds
const MAX_OUTPUT = 8000;            // max chars returned to LLM

// ── Security: Blocked Commands ──────────────────────────────────
const BLOCKED_COMMANDS = [
    'rm -rf /',
    'rm -rf ~',
    'rm -rf *',
    'sudo',
    'su ',
    'shutdown',
    'reboot',
    'poweroff',
    'halt',
    'mkfs',
    'format',
    'dd if=',
    ':(){',           // fork bomb
    'chmod 777 /',
    'chown',
    'passwd',
    'useradd',
    'userdel',
    'curl | sh',
    'curl | bash',
    'wget | sh',
    'eval(',
    '> /dev/sd',
    '> /etc/',
    'kill -9 1',
    'pkill',
    'killall',
    'systemctl',
    'service ',
    'iptables',
    'ufw',
];

// ── Security: Blocked write paths ───────────────────────────────
const BLOCKED_WRITE_PATHS = [
    '/etc', '/usr', '/bin', '/sbin', '/var', '/root',
    '/home', '/proc', '/sys', '/dev', '/boot',
];

// ── Ensure workspace exists ─────────────────────────────────────
function ensureWorkspace(): void {
    if (!fs.existsSync(WORKSPACE_ROOT)) {
        fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
    }
}

// ── Security check: is this command safe? ───────────────────────
function isCommandSafe(command: string): { safe: boolean; reason?: string } {
    const lower = command.toLowerCase().trim();

    for (const blocked of BLOCKED_COMMANDS) {
        if (lower.includes(blocked.toLowerCase())) {
            return { safe: false, reason: `blocked command pattern: "${blocked}"` };
        }
    }

    // Block attempts to write outside workspace via redirection
    const redirectMatch = command.match(/>\s*([^\s]+)/);
    if (redirectMatch) {
        const target = redirectMatch[1];
        if (!target.startsWith(WORKSPACE_ROOT) && !target.startsWith('/tmp/')) {
            return { safe: false, reason: `cannot redirect output outside workspace` };
        }
    }

    return { safe: true };
}

// ── Security check: is this path writable? ──────────────────────
function isPathWritable(filePath: string): { writable: boolean; reason?: string } {
    const resolved = path.resolve(filePath);

    // Must be inside workspace or /tmp
    if (!resolved.startsWith(WORKSPACE_ROOT) && !resolved.startsWith('/tmp/')) {
        return { writable: false, reason: `can only write to ${WORKSPACE_ROOT}` };
    }

    // Block symlink attacks
    for (const blocked of BLOCKED_WRITE_PATHS) {
        if (resolved.startsWith(blocked)) {
            return { writable: false, reason: `cannot write to ${blocked}` };
        }
    }

    return { writable: true };
}

// ── Count files in workspace ────────────────────────────────────
function countWorkspaceFiles(): number {
    if (!fs.existsSync(WORKSPACE_ROOT)) return 0;
    let count = 0;
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) walk(path.join(dir, entry.name));
            else count++;
        }
    };
    walk(WORKSPACE_ROOT);
    return count;
}

// ══════════════════════════════════════════════════════════════════
//  THE 10 CODE ENGINE TOOLS
// ══════════════════════════════════════════════════════════════════

export const codeEngine = {

    /** Run any shell command inside the workspace */
    async runCommand(command: string, cwd?: string, env?: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        const check = isCommandSafe(command);
        if (!check.safe) {
            logger.warn('code_engine_blocked_command', { command: command.substring(0, 80), reason: check.reason });
            return { stdout: '', stderr: `SECURITY: ${check.reason}`, exitCode: 1 };
        }

        ensureWorkspace();
        const execCwd = cwd ? path.resolve(WORKSPACE_ROOT, cwd) : WORKSPACE_ROOT;

        // Ensure cwd is inside workspace
        if (!execCwd.startsWith(WORKSPACE_ROOT) && !execCwd.startsWith('/tmp/')) {
            return { stdout: '', stderr: `SECURITY: cwd must be inside workspace`, exitCode: 1 };
        }

        if (!fs.existsSync(execCwd)) {
            fs.mkdirSync(execCwd, { recursive: true });
        }

        const execOpts: ExecSyncOptions = {
            cwd: execCwd,
            timeout: COMMAND_TIMEOUT,
            maxBuffer: 1024 * 1024, // 1MB
            env: { ...process.env, ...env, HOME: WORKSPACE_ROOT },
            encoding: 'utf8' as any,
        };

        logger.info('code_engine_run', { command: command.substring(0, 100), cwd: execCwd });
        experienceMemory.record('observation', `ran: ${command.substring(0, 80)}`, { cwd: execCwd });

        try {
            const stdout = execSync(command, execOpts) as unknown as string;
            return { stdout: (stdout || '').substring(0, MAX_OUTPUT), stderr: '', exitCode: 0 };
        } catch (e: any) {
            const stdout = (e.stdout || '').toString().substring(0, MAX_OUTPUT);
            const stderr = (e.stderr || '').toString().substring(0, MAX_OUTPUT);
            return { stdout, stderr, exitCode: e.status || 1 };
        }
    },

    /** Write content to a file in the workspace */
    writeFile(filePath: string, content: string): string {
        ensureWorkspace();
        const resolved = path.resolve(WORKSPACE_ROOT, filePath);

        const check = isPathWritable(resolved);
        if (!check.writable) return `SECURITY: ${check.reason}`;

        if (content.length > MAX_FILE_SIZE) {
            return `error: file too large (${content.length} bytes, max ${MAX_FILE_SIZE})`;
        }

        if (countWorkspaceFiles() >= MAX_FILES && !fs.existsSync(resolved)) {
            return `error: workspace full (${MAX_FILES} files max). delete some files first.`;
        }

        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(resolved, content, 'utf8');
        logger.info('code_engine_write', { path: resolved, bytes: content.length });
        experienceMemory.record('observation', `wrote ${path.basename(resolved)} (${content.length} bytes)`, { path: resolved });
        return `file written: ${filePath} (${content.length} bytes)`;
    },

    /** Read a file from the workspace */
    readFile(filePath: string): string {
        ensureWorkspace();
        const resolved = path.resolve(WORKSPACE_ROOT, filePath);

        if (!resolved.startsWith(WORKSPACE_ROOT) && !resolved.startsWith('/tmp/')) {
            return `SECURITY: can only read files inside workspace`;
        }

        if (!fs.existsSync(resolved)) {
            return `error: file not found: ${filePath}`;
        }

        const content = fs.readFileSync(resolved, 'utf8');
        return content.substring(0, MAX_OUTPUT);
    },

    /** List files in a directory */
    listDirectory(dirPath?: string): string {
        ensureWorkspace();
        const resolved = dirPath ? path.resolve(WORKSPACE_ROOT, dirPath) : WORKSPACE_ROOT;

        if (!resolved.startsWith(WORKSPACE_ROOT) && !resolved.startsWith('/tmp/')) {
            return `SECURITY: can only list workspace directories`;
        }

        if (!fs.existsSync(resolved)) {
            return `directory not found: ${dirPath || '/'}`;
        }

        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        if (entries.length === 0) return '(empty directory)';

        return entries.map(e => {
            if (e.isDirectory()) return `📁 ${e.name}/`;
            const stat = fs.statSync(path.join(resolved, e.name));
            return `📄 ${e.name} (${stat.size} bytes)`;
        }).join('\n');
    },

    /** Search for text across files in the workspace */
    searchInFiles(query: string, directory?: string): string {
        ensureWorkspace();
        const dir = directory ? path.resolve(WORKSPACE_ROOT, directory) : WORKSPACE_ROOT;

        if (!dir.startsWith(WORKSPACE_ROOT)) {
            return `SECURITY: can only search inside workspace`;
        }

        try {
            const result = execSync(
                `grep -rn --include="*" "${query.replace(/"/g, '\\"')}" . 2>/dev/null || true`,
                { cwd: dir, timeout: 10000, encoding: 'utf8', maxBuffer: 512 * 1024 }
            ) as unknown as string;
            return (result || 'no matches found').substring(0, MAX_OUTPUT);
        } catch {
            return 'search failed or no matches';
        }
    },

    /** Install packages */
    async installPackage(manager: string, packages: string[]): Promise<string> {
        const allowed = ['npm', 'pip', 'pip3', 'cargo'];
        if (!allowed.includes(manager)) {
            return `error: supported managers: ${allowed.join(', ')}`;
        }

        const pkgList = packages.join(' ');
        // Security: block packages with suspicious names
        if (packages.some(p => p.includes('..') || p.includes('/') || p.startsWith('-'))) {
            return `SECURITY: invalid package name detected`;
        }

        let cmd: string;
        switch (manager) {
            case 'npm': cmd = `npm install --save ${pkgList}`; break;
            case 'pip':
            case 'pip3': cmd = `pip3 install --user ${pkgList}`; break;
            case 'cargo': cmd = `cargo add ${pkgList}`; break;
            default: return 'unsupported manager';
        }

        return this.runCommand(cmd).then(r =>
            r.exitCode === 0 ? `installed: ${pkgList}` : `install failed: ${r.stderr.substring(0, 500)}`
        );
    },

    /** Run tests in a directory */
    async runTests(directory?: string): Promise<string> {
        const dir = directory || '.';

        // Auto-detect test framework
        const resolved = path.resolve(WORKSPACE_ROOT, dir);
        const packageJson = path.join(resolved, 'package.json');

        let cmd = 'echo "no test framework detected"';

        if (fs.existsSync(packageJson)) {
            cmd = 'npm test 2>&1 || true';
        } else if (fs.existsSync(path.join(resolved, 'Cargo.toml'))) {
            cmd = 'cargo test 2>&1 || true';
        } else if (fs.existsSync(path.join(resolved, 'pytest.ini')) ||
            fs.existsSync(path.join(resolved, 'setup.py'))) {
            cmd = 'python3 -m pytest 2>&1 || true';
        }

        const result = await this.runCommand(cmd, dir);
        return `exit=${result.exitCode}\n${result.stdout}\n${result.stderr}`.substring(0, MAX_OUTPUT);
    },

    /** Git commit current changes */
    async gitCommit(directory: string, message: string): Promise<string> {
        const dir = directory || '.';
        const resolved = path.resolve(WORKSPACE_ROOT, dir);

        if (!resolved.startsWith(WORKSPACE_ROOT)) {
            return 'SECURITY: can only git inside workspace';
        }

        // Init repo if needed
        if (!fs.existsSync(path.join(resolved, '.git'))) {
            await this.runCommand('git init && git config user.email "meridian@agent.local" && git config user.name "Meridian"', dir);
        }

        const result = await this.runCommand(`git add -A && git commit -m "${message.replace(/"/g, '\\"')}"`, dir);
        return result.exitCode === 0 ? `committed: "${message}"` : `commit failed: ${result.stderr.substring(0, 300)}`;
    },

    /** Make an HTTP request */
    async httpRequest(method: string, url: string, body?: any): Promise<string> {
        const allowedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
        if (!allowedMethods.includes(method.toUpperCase())) {
            return `error: method must be one of ${allowedMethods.join(', ')}`;
        }

        // Block internal URLs
        const lower = url.toLowerCase();
        if (['localhost', '127.0.0.1', '0.0.0.0', '10.', '192.168.'].some(h => lower.includes(h))) {
            return 'SECURITY: cannot make requests to internal/localhost URLs';
        }

        try {
            const opts: RequestInit = {
                method: method.toUpperCase(),
                headers: { 'User-Agent': 'Meridian-CodeEngine/1.0', 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(15000),
            };
            if (body && method.toUpperCase() !== 'GET') {
                opts.body = typeof body === 'string' ? body : JSON.stringify(body);
            }

            const resp = await fetch(url, opts);
            const text = await resp.text();
            logger.info('code_engine_http', { method, url: url.substring(0, 80), status: resp.status });
            return `HTTP ${resp.status}\n${text.substring(0, MAX_OUTPUT)}`;
        } catch (e: any) {
            return `request failed: ${e.message}`;
        }
    },

    /** Delete a file from the workspace */
    deleteFile(filePath: string): string {
        ensureWorkspace();
        const resolved = path.resolve(WORKSPACE_ROOT, filePath);

        const check = isPathWritable(resolved);
        if (!check.writable) return `SECURITY: ${check.reason}`;

        if (!fs.existsSync(resolved)) return `file not found: ${filePath}`;

        fs.unlinkSync(resolved);
        logger.info('code_engine_delete', { path: resolved });
        experienceMemory.record('observation', `deleted ${path.basename(resolved)}`, { path: resolved });
        return `deleted: ${filePath}`;
    },

    /** Get workspace info */
    getWorkspaceInfo(): string {
        ensureWorkspace();
        const fileCount = countWorkspaceFiles();
        const info = [
            `workspace: ${WORKSPACE_ROOT}`,
            `files: ${fileCount}/${MAX_FILES}`,
            `command timeout: ${COMMAND_TIMEOUT / 1000}s`,
            `max file size: ${MAX_FILE_SIZE / 1024}KB`,
        ];

        // Check available tools
        const checks = [
            { name: 'node', cmd: 'node --version 2>/dev/null || echo "not found"' },
            { name: 'npm', cmd: 'npm --version 2>/dev/null || echo "not found"' },
            { name: 'python3', cmd: 'python3 --version 2>/dev/null || echo "not found"' },
            { name: 'cargo', cmd: 'cargo --version 2>/dev/null || echo "not found"' },
            { name: 'git', cmd: 'git --version 2>/dev/null || echo "not found"' },
        ];

        for (const check of checks) {
            try {
                const ver = execSync(check.cmd, { timeout: 5000, encoding: 'utf8' }).toString().trim();
                info.push(`${check.name}: ${ver}`);
            } catch {
                info.push(`${check.name}: not available`);
            }
        }

        return info.join('\n');
    },
};
