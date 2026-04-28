#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const { Confirm, Select } = require('enquirer');
const { formatDistanceToNow } = require('date-fns');

const HOME = os.homedir();
const CLAUDE_HISTORY = path.join(HOME, '.claude', 'history.jsonl');
const CODEX_HISTORY = path.join(HOME, '.codex', 'history.jsonl');
const GEMINI_DIR = path.join(HOME, '.gemini');

function warn(message, error) {
    const details = error && error.message ? `: ${error.message}` : '';
    console.warn(`Warning: ${message}${details}`);
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonLines(file, label) {
    if (!fs.existsSync(file)) return [];

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const rows = [];
    for (const line of lines) {
        try {
            rows.push(JSON.parse(line));
        } catch (e) {
            warn(`Skipping malformed ${label} entry`, e);
        }
    }
    return rows;
}

function listFilesRecursive(dir, predicate = () => true) {
    if (!fs.existsSync(dir)) return [];

    const files = [];
    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (e) {
            warn(`Could not read directory ${current}`, e);
            continue;
        }

        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
            } else if (entry.isFile() && predicate(fullPath)) {
                files.push(fullPath);
            }
        }
    }

    return files;
}

function normalizeText(value, fallback = '(No description)') {
    if (typeof value !== 'string') return fallback;
    const text = value.replace(/\s+/g, ' ').trim();
    return text || fallback;
}

function firstLine(value) {
    if (typeof value !== 'string') return '(No description)';
    return normalizeText(value.split('\n')[0].substring(0, 80));
}

function normalizeTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = new Date(value).getTime();
        if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
}

function appendSession(sessions, session) {
    if (!session.id) return;
    const current = sessions[session.id];
    const next = {
        ...session,
        description: firstLine(session.description),
        timestamp: normalizeTimestamp(session.timestamp)
    };

    if (!current) {
        sessions[session.id] = next;
        return;
    }

    if (next.project && !current.project) current.project = next.project;
    if (current.description === '(No description)' && next.description !== '(No description)') {
        current.description = next.description;
    }

    if (next.timestamp >= current.timestamp) {
        sessions[session.id] = {
            ...current,
            ...next,
            description: next.description !== '(No description)' ? next.description : current.description,
            project: next.project || current.project
        };
    }
}

function extractContent(content, allowedTypes) {
    if (typeof content === 'string') return normalizeText(content, '');
    if (!Array.isArray(content)) return '';

    return content
        .map((part) => {
            if (!part || typeof part !== 'object') return '';
            if (allowedTypes && part.type && !allowedTypes.includes(part.type)) return '';
            return typeof part.text === 'string' ? part.text : '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
}

function isUsefulUserText(text) {
    return text && !text.startsWith('<environment_context>');
}

function extractCodexResponseMessage(data) {
    const payload = data && data.payload;
    if (!payload || payload.type !== 'message') return null;
    if (!['user', 'assistant'].includes(payload.role)) return null;

    const text = extractContent(
        payload.content,
        payload.role === 'user' ? ['input_text'] : ['output_text']
    );
    if (payload.role === 'user' && !isUsefulUserText(text)) return null;
    if (!text) return null;

    return `[${payload.role.toUpperCase()}]: ${text}`;
}

function extractCodexLegacyMessage(data) {
    const payload = data && data.payload;
    if (!payload || !payload.message) return null;
    if (!['user_message', 'agent_message'].includes(payload.type)) return null;

    const text = normalizeText(payload.message, '');
    if (payload.type === 'user_message' && !isUsefulUserText(text)) return null;
    if (!text) return null;

    const role = payload.type === 'user_message' ? 'USER' : 'ASSISTANT';
    return `[${role}]: ${text}`;
}

function extractClaudeMessage(data) {
    if (!data || !data.message) return null;

    if (data.type === 'user') {
        const text = extractContent(data.message.content, ['text']);
        if (!text) return null;
        return `[USER]: ${text}`;
    }

    if (data.type === 'assistant') {
        const text = extractContent(data.message.content, ['text']);
        if (!text) return null;
        return `[ASSISTANT]: ${text}`;
    }

    return null;
}

function extractGeminiMessage(message) {
    if (!message || !['user', 'gemini', 'assistant', 'model'].includes(message.type)) return null;

    const text = extractContent(message.content, ['text']);
    if (!text) return null;

    const role = message.type === 'user' ? 'USER' : 'ASSISTANT';
    return `[${role}]: ${text}`;
}

async function getClaudeSessions() {
    if (!fs.existsSync(CLAUDE_HISTORY)) return [];
    const sessions = {};
    for (const data of readJsonLines(CLAUDE_HISTORY, 'Claude history')) {
        if (!data.sessionId) continue;
        appendSession(sessions, {
            tool: 'claude',
            id: data.sessionId,
            description: data.display,
            timestamp: data.timestamp,
            project: data.project
        });
    }
    return Object.values(sessions);
}

async function getCodexSessions() {
    const sessions = {};
    for (const data of readJsonLines(CODEX_HISTORY, 'Codex history')) {
        if (!data.session_id) continue;
        appendSession(sessions, {
            tool: 'codex',
            id: data.session_id,
            description: data.text,
            timestamp: typeof data.ts === 'number' ? data.ts * 1000 : data.ts,
            project: null
        });
    }

    const sessionsDir = path.join(HOME, '.codex', 'sessions');
    const rolloutFiles = listFilesRecursive(sessionsDir, file => path.basename(file).startsWith('rollout-') && file.endsWith('.jsonl'));
    for (const file of rolloutFiles) {
        const rows = readJsonLines(file, 'Codex rollout');
        const meta = rows.find(row => row.type === 'session_meta' && row.payload && row.payload.id);
        if (!meta) continue;

        const firstUserMessage = rows
            .map(extractCodexResponseMessage)
            .find(message => message && message.startsWith('[USER]: '));

        appendSession(sessions, {
            tool: 'codex',
            id: meta.payload.id,
            description: firstUserMessage ? firstUserMessage.replace('[USER]: ', '') : undefined,
            timestamp: meta.payload.timestamp || meta.timestamp,
            project: meta.payload.cwd
        });
    }

    return Object.values(sessions);
}

function getGeminiProjects() {
    const projectsPath = path.join(GEMINI_DIR, 'projects.json');
    const projects = {};

    if (fs.existsSync(projectsPath)) {
        try {
            Object.assign(projects, readJson(projectsPath).projects || {});
        } catch (e) {
            warn('Could not read Gemini projects.json', e);
        }
    }

    const tmpDir = path.join(GEMINI_DIR, 'tmp');
    if (fs.existsSync(tmpDir)) {
        try {
            for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const projectRootFile = path.join(tmpDir, entry.name, '.project_root');
                if (!fs.existsSync(projectRootFile)) continue;
                const projectPath = fs.readFileSync(projectRootFile, 'utf8').trim();
                if (projectPath) projects[projectPath] = entry.name;
            }
        } catch (e) {
            warn('Could not inspect Gemini tmp projects', e);
        }
    }

    return projects;
}

async function getGeminiSessions() {
    const sessions = [];
    const projectsData = getGeminiProjects();

    for (const [projectPath, projectId] of Object.entries(projectsData)) {
        const logsPath = path.join(GEMINI_DIR, 'tmp', projectId, 'logs.json');
        if (!fs.existsSync(logsPath)) continue;

        try {
            const logs = readJson(logsPath);
            const projectSessions = {};
            for (const log of Array.isArray(logs) ? logs : []) {
                if (!log.sessionId) continue;
                appendSession(projectSessions, {
                    tool: 'gemini',
                    id: log.sessionId,
                    description: log.message,
                    timestamp: log.timestamp,
                    project: projectPath
                });
            }
            sessions.push(...Object.values(projectSessions));
        } catch (e) {
            warn(`Could not read Gemini logs for ${projectPath}`, e);
        }
    }
    return sessions;
}

async function getTranscript(s) {
    if (s.tool === 'gemini') {
        try {
            const projectsData = getGeminiProjects();
            const projectId = projectsData[s.project];
            if (!projectId) {
                warn(`Could not map Gemini project ${s.project}`);
                return null;
            }
            const chatDir = path.join(GEMINI_DIR, 'tmp', projectId, 'chats');
            const files = listFilesRecursive(chatDir, file => file.endsWith('.json'));
            for (const file of files) {
                const data = readJson(file);
                if (data.sessionId !== s.id) continue;

                return (Array.isArray(data.messages) ? data.messages : [])
                    .map(extractGeminiMessage)
                    .filter(Boolean)
                    .join('\n\n');
            }
            warn(`Could not find Gemini transcript for ${s.id}`);
        } catch (e) {
            warn(`Could not read Gemini transcript for ${s.id}`, e);
        }
    } else if (s.tool === 'codex') {
        try {
            const sessionsDir = path.join(HOME, '.codex', 'sessions');
            const rolloutFiles = listFilesRecursive(sessionsDir, file => path.basename(file).includes(s.id) && file.endsWith('.jsonl'));
            if (!rolloutFiles[0]) {
                warn(`Could not find Codex transcript for ${s.id}`);
                return null;
            }

            const rows = readJsonLines(rolloutFiles[0], 'Codex transcript');
            const responseMessages = rows.map(extractCodexResponseMessage).filter(Boolean);
            if (responseMessages.length > 0) return responseMessages.join('\n\n');

            return rows.map(extractCodexLegacyMessage).filter(Boolean).join('\n\n');
        } catch (e) {
            warn(`Could not read Codex transcript for ${s.id}`, e);
        }
    } else if (s.tool === 'claude') {
        try {
            const projectsDir = path.join(HOME, '.claude', 'projects');
            const sessionFiles = listFilesRecursive(projectsDir, file => path.basename(file) === `${s.id}.jsonl`);
            if (sessionFiles[0]) {
                return readJsonLines(sessionFiles[0], 'Claude transcript')
                    .map(extractClaudeMessage)
                    .filter(Boolean)
                    .join('\n\n');
            }
        } catch (e) {
            warn(`Could not read Claude transcript for ${s.id}`, e);
        }

        // Final fallback to user prompts from history.jsonl
        return readJsonLines(CLAUDE_HISTORY, 'Claude history fallback')
            .map(data => data.sessionId === s.id ? `[USER]: ${normalizeText(data.display, '')}` : null)
            .filter(Boolean)
            .join('\n\n');
    }
    return null;
}

async function resolveCwd(project) {
    if (!project) return process.cwd();
    if (fs.existsSync(project) && fs.statSync(project).isDirectory()) return project;

    warn(`Saved project directory does not exist: ${project}`);
    const useCurrent = await new Confirm({
        name: 'useCurrent',
        message: `Use current directory instead (${process.cwd()})?`,
        initial: false
    }).run();

    if (!useCurrent) process.exit(1);
    return process.cwd();
}

async function resumeSession(s, targetTool) {
    const cwd = await resolveCwd(s.project);

    if (s.tool === targetTool) {
        console.log(`\nResuming ${s.tool.toUpperCase()} session in ${cwd}...`);
        let cmd, args;
        if (s.tool === 'claude') {
            cmd = 'claude';
            args = ['--resume', s.id];
        } else if (s.tool === 'codex') {
            cmd = 'codex';
            args = ['resume', s.id];
            args.push('-C', cwd);
        } else if (s.tool === 'gemini') {
            try {
                const list = execSync(`gemini --list-sessions`, { cwd }).toString();
                const lines = list.split('\n');
                let index = null;
                for (const line of lines) {
                    if (line.includes(s.id)) {
                        const match = line.trim().match(/^(\d+)\./);
                        if (match) { index = match[1]; break; }
                    }
                }
                if (index) {
                    cmd = 'gemini';
                    args = ['--resume', index];
                } else {
                    console.error('Could not find session index for Gemini session.');
                    process.exit(1);
                }
            } catch (e) {
                console.error('Error listing gemini sessions:', e.message);
                process.exit(1);
            }
        }
        spawn(cmd, args, { cwd, stdio: 'inherit' }).on('exit', (code) => process.exit(code || 0));
    } else {
        console.log(`\nMigrating session from ${s.tool.toUpperCase()} to ${targetTool.toUpperCase()}...`);
        const transcript = await getTranscript(s);
        if (!transcript || !transcript.trim()) {
            console.error(`Could not extract a transcript for ${s.tool.toUpperCase()} session ${s.id}. Migration aborted.`);
            process.exit(1);
        }
        const initialPrompt = `Continuing session from ${s.tool.toUpperCase()}.\n\nTranscript:\n${transcript}\n\nPlease resume from where we left off.`;

        let cmd, args;
        if (targetTool === 'claude') {
            cmd = 'claude';
            args = [initialPrompt];
        } else if (targetTool === 'codex') {
            cmd = 'codex';
            args = [initialPrompt];
        } else if (targetTool === 'gemini') {
            cmd = 'gemini';
            args = [initialPrompt];
        }

        spawn(cmd, args, { cwd, stdio: 'inherit' }).on('exit', (code) => process.exit(code || 0));
    }
}

async function main() {
    const [claude, codex, gemini] = await Promise.all([
        getClaudeSessions(),
        getCodexSessions(),
        getGeminiSessions()
    ]);

    let allSessions = [...claude, ...codex, ...gemini];
    allSessions.sort((a, b) => b.timestamp - a.timestamp);
    allSessions = allSessions.slice(0, 30);

    if (allSessions.length === 0) {
        console.log('No sessions found.');
        return;
    }

    const sessionChoices = allSessions.map((s, i) => {
        const toolColor = s.tool === 'gemini' ? '\x1B[34m' : s.tool === 'claude' ? '\x1B[33m' : '\x1B[35m';
        const reset = '\x1B[0m';
        const time = formatDistanceToNow(s.timestamp, { addSuffix: true });
        const tool = `${toolColor}[${s.tool.toUpperCase()}]${reset}`;
        const desc = (s.description.trim() || '(No description)').replace(/\n/g, ' ');
        return { name: i.toString(), message: `${tool} ${desc}`, hint: `(${time})` };
    });

    const sessionPrompt = new Select({
        name: 'session',
        message: 'Select a session to resume',
        choices: sessionChoices,
    });

    try {
        const sessionIndex = parseInt(await sessionPrompt.run());
        const selectedSession = allSessions[sessionIndex];

        const toolChoices = [
            { name: 'gemini', message: '\x1B[34m[GEMINI]\x1B[0m Gemini CLI' },
            { name: 'claude', message: '\x1B[33m[CLAUDE]\x1B[0m Claude Code' },
            { name: 'codex', message: '\x1B[35m[CODEX]\x1B[0m Codex CLI' }
        ];

        const toolPrompt = new Select({
            name: 'tool',
            message: `Resume in which tool?`,
            choices: toolChoices,
            initial: toolChoices.findIndex(t => t.name === selectedSession.tool)
        });

        const targetTool = await toolPrompt.run();
        await resumeSession(selectedSession, targetTool);

    } catch (e) {
        process.exit(0);
    }
}

main();
