import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

// 直接验证编译后的公开协议；隔离账户与 workspace，不调用生产模型。
const bundle = process.argv[2];
if (!bundle) throw Error('Usage: node standalone-session-lifecycle.test.mjs <zcode.cjs>');

class ProtocolClient {
  constructor(root, workspace) {
    this.pending = new Map();
    this.nextId = 0;
    this.child = spawn(process.execPath, [bundle, 'app-server', '--stdio', '--standalone'], {
      cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, USERPROFILE: root, HOME: root, ZCODE_DATA_BASE_DIR: root },
    });
    this.reader = readline.createInterface({ input: this.child.stdout });
    this.reader.on('line', line => {
      let frame;
      try { frame = JSON.parse(line); } catch { return; }
      if (frame.method && frame.id) {
        this.write({ id: frame.id, ...(frame.method === 'session/requestRuntimePreferences'
          ? { result: { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false } }
          : { error: { code: -32601, message: 'Not provided by lifecycle test' } }) });
      } else {
        const receive = this.pending.get(frame.id);
        if (receive) { this.pending.delete(frame.id); receive(frame); }
      }
    });
  }
  write(frame) { this.child.stdin.write(JSON.stringify(frame) + '\n'); }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = `lifecycle-${++this.nextId}`;
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`${method} timed out`)); }, 30000);
      this.pending.set(id, frame => {
        clearTimeout(timer);
        if (frame.error) reject(Error(frame.error.message)); else resolve(frame.result);
      });
      this.write({ id, method, params });
    });
  }
  async close() {
    this.child.stdin.end();
    const timer = setTimeout(() => {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else this.child.kill('SIGKILL');
    }, 3000);
    try { await new Promise(resolve => this.child.exitCode === null ? this.child.once('exit', resolve) : resolve()); }
    finally { clearTimeout(timer); this.reader.close(); }
  }
}

test('没有模型和首条消息时，持久会话跨进程恢复；deferred 保持草稿', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-empty-lifecycle-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const ref = { workspacePath: workspace, workspaceKey: workspace };
  let client = new ProtocolClient(root, workspace);
  const sessions = [];
  try {
    for (const persistence of [undefined, 'immediate', 'deferred']) {
      const result = await client.request('session/create', { workspace: ref, titleGenerationEnabled: false, ...(persistence ? { persistence } : {}) });
      assert.equal(result.settings.model.available.length, 0);
      sessions.push({ id: result.session.sessionId, persistence });
    }
  } finally { await client.close(); }
  client = new ProtocolClient(root, workspace);
  try {
    for (const { id, persistence } of sessions) {
      if (persistence === 'deferred') {
        await assert.rejects(client.request('session/resume', { sessionId: id, workspace: ref }), /Session not found/);
      } else {
        const restored = await client.request('session/resume', { sessionId: id, workspace: ref });
        assert.equal(restored.session.sessionId, id);
        assert.equal(restored.messages.length, 0);
      }
    }
  } finally { await client.close(); }
});
