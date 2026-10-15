import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from '../../../node_modules/typescript/lib/typescript.js';

const source = await readFile(new URL('../packages/cli/src/arguments.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { parseGlobalArgs, isProtocolServerInvocation } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

test('第三方宿主可显式启动独立协议进程，桌面默认保持不变', () => {
  assert.equal(parseGlobalArgs(['app-server', '--stdio', '--standalone']).values.standalone, true);
  assert.equal(parseGlobalArgs(['app-server', '--stdio']).values.standalone, undefined);
  assert.equal(isProtocolServerInvocation(['app-server', '--standalone']), true);
});
