#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const { Select } = require('enquirer');
const { formatDistanceToNow } = require('date-fns');

const HOME = os.homedir();
const CLAUDE_HISTORY = path.join(HOME, '.claude', 'history.jsonl');
const CODEX_HISTORY = path.join(HOME, '.codex', 'history.jsonl');
const GEMINI_DIR = path.join(HOME, '.gemini');

async function getClaudeSessions() {
    if (!fs.existsSync(CLAUDE_HISTORY)) return [];
    const content = fs.readFileSync(CLAUDE_HISTORY, 'utf8');
    const lines = content.trim().split('\n');
    const sessions = {};
    for (const line of lines) {
        try {
            const data = JSON.parse(line);
            if (!data.sessionId) continue;
            if (!sessions[data.sessionId]) {
                sessions[data.sessionId] = {
                    tool: 'claude',
                    id: data.sessionId,
                    description: data.display,
                    timestamp: data.timestamp,
                    project: data.project
                };
            } else {
                sessions[data.sessionId].timestamp = Math.max(sessions[data.sessionId].timestamp, data.timestamp);
            }
        } catch (e) {}
    }
    return Object.values(sessions);
}

async function getCodexSessions() {
    if (!fs.existsSync(CODEX_HISTORY)) return [];
    const content = fs.readFileSync(CODEX_HISTORY, 'utf8');
    const lines = content.trim().split('\n');
    const sessions = {};
    for (const line of lines) {
        try {
            const data = JSON.parse(line);
            if (!data.session_id) continue;
            if (!sessions[data.session_id]) {
                sessions[data.session_id] = {
                    tool: 'codex',
                    id: data.session_id,
                    description: data.text.split('\n')[0].substring(0, 80),
                    timestamp: data.ts * 1000,
                    project: null
                };
            } else {
                sessions[data.session_id].timestamp = Math.max(sessions[data.session_id].timestamp, data.ts * 1000);
            }
        } catch (e) {}
    }

    const sessionsDir = path.join(HOME, '.codex', 'sessions');
    if (fs.existsSync(sessionsDir)) {
        try {
            const rolloutFiles = execSync(`find "${sessionsDir}" -name "rollout-*.jsonl"`).toString().split('\n');
            for (const file of rolloutFiles) {
                if (!file) continue;
                try {
                    const firstLine = execSync(`head -n 1 "${file}"`).toString();
                    const data = JSON.parse(firstLine);
                    if (data.type === 'session_meta' && data.payload && sessions[data.payload.id]) {
                        sessions[data.payload.id].project = data.payload.cwd;
                    }
                } catch (e) {}
            }
        } catch (e) {}
    }

    return Object.values(sessions).map(s => {
        if (!s.project) s.project = process.cwd();
        return s;
    });
}

async function getGeminiSessions() {
    const sessions = [];
    const projectsPath = path.join(GEMINI_DIR, 'projects.json');
    if (!fs.existsSync(projectsPath)) return [];
    
    try {
        const projectsData = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
        for (const [projectPath, projectId] of Object.entries(projectsData.projects)) {
            const logsPath = path.join(GEMINI_DIR, 'tmp', projectId, 'logs.json');
            if (fs.existsSync(logsPath)) {
                try {
                    const logs = JSON.parse(fs.readFileSync(logsPath, 'utf8'));
                    const projectSessions = {};
                    for (const log of logs) {
                        if (!log.sessionId) continue;
                        if (!projectSessions[log.sessionId]) {
                            projectSessions[log.sessionId] = {
                                tool: 'gemini',
                                id: log.sessionId,
                                description: log.message.split('\n')[0].substring(0, 80),
                                timestamp: new Date(log.timestamp).getTime(),
                                project: projectPath
                            };
                        } else {
                            projectSessions[log.sessionId].timestamp = Math.max(
                                projectSessions[log.sessionId].timestamp, 
                                new Date(log.timestamp).getTime()
                            );
                        }
                    }
                    sessions.push(...Object.values(projectSessions));
                } catch (e) {}
            }
        }
    } catch (e) {}
    return sessions;
}

async function getTranscript(s) {
    if (s.tool === 'gemini') {
        try {
            const projectsData = JSON.parse(fs.readFileSync(path.join(GEMINI_DIR, 'projects.json'), 'utf8'));
            const projectId = projectsData.projects[s.project];
            const chatDir = path.join(GEMINI_DIR, 'tmp', projectId, 'chats');
            const files = fs.readdirSync(chatDir);
            const sessionFile = files.find(f => f.includes(s.id.substring(0, 8)));
            if (sessionFile) {
                const data = JSON.parse(fs.readFileSync(path.join(chatDir, sessionFile), 'utf8'));
                return data.messages.map(m => {
                    const content = Array.isArray(m.content) ? m.content.map(c => c.text).join('') : (m.content || '');
                    return `[${m.type.toUpperCase()}]: ${content}`;
                }).join('\n\n');
            }
        } catch (e) {}
    } else if (s.tool === 'codex') {
        try {
            const sessionsDir = path.join(HOME, '.codex', 'sessions');
            const rolloutFiles = execSync(`find "${sessionsDir}" -name "rollout-*${s.id}*.jsonl"`).toString().split('\n');
            if (rolloutFiles[0]) {
                const content = fs.readFileSync(rolloutFiles[0], 'utf8');
                return content.split('\n').filter(l => l).map(l => {
                    const data = JSON.parse(l);
                    if (data.type === 'event_msg' && data.payload.message) {
                        const role = data.payload.type === 'user_message' ? 'USER' : 'ASSISTANT';
                        return `[${role}]: ${data.payload.message}`;
                    }
                    return null;
                }).filter(m => m).join('\n\n');
            }
        } catch (e) {}
    } else if (s.tool === 'claude') {
        try {
            const projectsDir = path.join(HOME, '.claude', 'projects');
            const sessionFiles = execSync(`find "${projectsDir}" -name "${s.id}.jsonl"`).toString().split('\n');
            if (sessionFiles[0]) {
                const content = fs.readFileSync(sessionFiles[0], 'utf8');
                return content.split('\n').filter(l => l).map(l => {
                    const data = JSON.parse(l);
                    if (data.type === 'user') {
                        const content = Array.isArray(data.message.content) ? data.message.content.map(c => c.text).join('') : data.message.content;
                        return `[USER]: ${content}`;
                    } else if (data.type === 'assistant') {
                        const content = Array.isArray(data.message.content) ? data.message.content.map(c => c.text || c.thinking || '').join('') : data.message.content;
                        return `[ASSISTANT]: ${content}`;
                    }
                    return null;
                }).filter(m => m).join('\n\n');
            }
        } catch (e) {}
        
        // Final fallback to user prompts from history.jsonl
        const content = fs.readFileSync(CLAUDE_HISTORY, 'utf8');
        return content.split('\n').filter(l => l).map(l => {
            const data = JSON.parse(l);
            if (data.sessionId === s.id) {
                return `[USER]: ${data.display}`;
            }
            return null;
        }).filter(m => m).join('\n\n');
    }
    return null;
}

async function resumeSession(s, targetTool) {
    if (s.tool === targetTool) {
        console.log(`\nResuming ${s.tool.toUpperCase()} session in ${s.project || process.cwd()}...`);
        let cmd, args;
        if (s.tool === 'claude') {
            cmd = 'claude';
            args = ['--resume', s.id];
        } else if (s.tool === 'codex') {
            cmd = 'codex';
            args = ['resume', s.id];
            if (s.project) args.push('-C', s.project);
        } else if (s.tool === 'gemini') {
            try {
                const list = execSync(`gemini --list-sessions`, { cwd: s.project || process.cwd() }).toString();
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
        spawn(cmd, args, { cwd: s.project || process.cwd(), stdio: 'inherit' }).on('exit', (code) => process.exit(code || 0));
    } else {
        console.log(`\nMigrating session from ${s.tool.toUpperCase()} to ${targetTool.toUpperCase()}...`);
        const transcript = await getTranscript(s);
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
        
        spawn(cmd, args, { cwd: s.project || process.cwd(), stdio: 'inherit' }).on('exit', (code) => process.exit(code || 0));
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
    allSessions = allSessions.slice(0, 15);
    allSessions.reverse();

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
        initial: sessionChoices.length - 1
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
