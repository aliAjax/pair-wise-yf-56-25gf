// 运行时用 typescript 转译并加载 .ts 逻辑文件做端到端自测
const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('./') && !request.endsWith('.ts')) {
    try { return origResolve.call(this, request + '.ts', ...rest); } catch { /* fallthrough */ }
  }
  return origResolve.call(this, request, ...rest);
};
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename
  });
  module._compile(out.outputText, filename);
};

const assert = require('assert');
const { OFFLINE_BATCH, FIRST_PUSH_FAILURE, ingestEvents, landIsolation, retryFailedIsolation } = require(path.join(__dirname, '../lib/incident-logic.ts'));
const { buildLedger } = require(path.join(__dirname, '../lib/reconciliation.ts'));

// 与 store.ts createInitialIncident 同构的初始夹具（隔离动作已获双角色批准）
const ref = Date.now();
const ago = (m) => new Date(ref - m * 60000).toISOString();
const affected = ['api-gateway', 'customer-portal', 'audit-log'];
let incident = {
  id: 'INC-2026-0929', title: 'x', severity: 'critical', status: 'investigating', affected,
  subIncidents: [],
  actions: [
    { id: 'act-1', title: '隔离异常凭证关联资产', kind: 'isolate', approvals: ['analyst', 'responder'], status: 'approved',
      assetResults: affected.map((asset) => ({ asset, status: 'pending', attempts: 0 })) },
    { id: 'act-3', title: '准备客户披露口径', kind: 'notify', approvals: ['legal'], status: 'approved' }
  ],
  timeline: [
    { id: 'e1', at: ago(35), receivedAt: ago(35), actor: '告警平台', text: '检测到同一凭证跨三个地域登录' },
    { id: 'e2', at: ago(30), receivedAt: ago(30), actor: '值班分析员', text: '确认会话未经过常规办公出口' }
  ],
  approvals: [
    { id: 'ap-1', actionId: 'act-1', role: 'analyst', at: ago(26), state: 'valid' },
    { id: 'ap-2', actionId: 'act-1', role: 'responder', at: ago(24), state: 'valid' },
    { id: 'ap-3', actionId: 'act-3', role: 'legal', at: ago(22), state: 'valid' }
  ],
  executions: []
};
const isolate = () => incident.actions.find((a) => a.id === 'act-1');

// 1) 首次补传：bf-1 成功，bf-2/bf-3 写失败（未提交）
const firstAt = new Date().toISOString();
const firstBatch = OFFLINE_BATCH.filter((e) => !FIRST_PUSH_FAILURE[e.id]);
let r1 = ingestEvents(incident, firstBatch, firstAt);
incident = r1.incident;
assert.deepStrictEqual(r1.ingested.map((e) => e.id), ['bf-1']);
assert.strictEqual(incident.timeline.find((e) => e.id === 'bf-1').receivedAt, firstAt);
assert.strictEqual(isolate().status, 'approved', '结论未变，旧审批仍可执行');

// 2) 重试整批：只写入没写进的 bf-2/bf-3；bf-1 重复不记
const retryAt = new Date().toISOString();
const r2 = ingestEvents(incident, OFFLINE_BATCH, retryAt);
incident = r2.incident;
assert.deepStrictEqual(r2.ingested.map((e) => e.id).sort(), ['bf-2', 'bf-3']);
assert.deepStrictEqual(r2.duplicates, ['bf-1']);

// 3) 再重放：全部重复，零新增
const r3 = ingestEvents(incident, OFFLINE_BATCH, new Date().toISOString());
assert.strictEqual(r3.ingested.length, 0);
assert.strictEqual(r3.duplicates.length, 3);

// 4) 晚到事件 bf-2 推翻结论 → act-1 审批失效退回待确认
const act1 = isolate();
assert.strictEqual(act1.status, 'pending');
assert.strictEqual(act1.approvals.length, 0);
assert.strictEqual(act1.invalidatedAt, retryAt);
assert.ok(incident.approvals.filter((a) => a.actionId === 'act-1').every((a) => a.state === 'invalidated'));
assert.strictEqual(incident.actions.find((a) => a.id === 'act-3').status, 'approved', '无关动作审批不受影响');

// 5) 重新双审批后，隔离按资产逐个落地：portal 成功，gateway 首次超时失败，audit-log 通道不可用失败
const reapproved = { ...act1, approvals: ['analyst', 'responder'], status: 'approved', invalidatedAt: undefined, invalidatedReason: undefined };
const land1 = landIsolation(reapproved, new Date().toISOString());
let action = land1.action;
incident = { ...incident, actions: incident.actions.map((a) => (a.id === 'act-1' ? action : a)), executions: [...incident.executions, ...land1.records] };
assert.strictEqual(action.status, 'partial');
assert.strictEqual(action.assetResults.find((x) => x.asset === 'customer-portal').status, 'isolated');
assert.deepStrictEqual(
  action.assetResults.filter((x) => x.status === 'failed').map((x) => x.asset),
  ['api-gateway', 'audit-log']
);
assert.strictEqual(land1.records.length, 3, '三个资产逐个出结果（成功/失败均单独记账）');

// 6) 重试失败项：gateway 成功，audit-log 持续失败；已隔离的 portal 跳过
const land2 = retryFailedIsolation(action, new Date().toISOString());
action = land2.action;
assert.strictEqual(action.assetResults.find((x) => x.asset === 'customer-portal').attempts, 1, '已隔离资产跳过');
assert.strictEqual(action.assetResults.find((x) => x.asset === 'api-gateway').status, 'isolated');
assert.strictEqual(action.assetResults.find((x) => x.asset === 'audit-log').status, 'failed');
assert.deepStrictEqual(land2.records.map((r) => r.asset).sort(), ['api-gateway', 'audit-log']);
assert.strictEqual(action.status, 'partial');

// 7) 对账台账按发生时间归并；补传事件收到最晚但归位到审批之前；补传时刻另记
const finalIncident = { ...incident, actions: incident.actions.map((a) => (a.id === 'act-1' ? action : a)), executions: [...incident.executions, ...land2.records] };
const ledger = buildLedger(finalIncident);
const times = ledger.map((e) => e.at);
assert.deepStrictEqual(times, [...times].sort(), '台账按发生时间升序');
const idx = Object.fromEntries(ledger.map((e, i) => [e.key, i]));
assert.ok(idx['event-bf-2'] < idx['approval-ap-1'], '晚到事件归位到原审批之前');
assert.ok(idx['event-bf-1'] < idx['event-e1'], '断网前最早告警归位到实时告警之前');
assert.strictEqual(ledger.find((e) => e.key === 'event-bf-2').receivedAt, retryAt, '补传时刻另记');
assert.strictEqual(ledger.find((e) => e.key === 'event-bf-2').at, OFFLINE_BATCH.find((e) => e.id === 'bf-2').at, '发生时间保持原值');
assert.ok(ledger.some((e) => e.kind === 'invalidation' && e.at === retryAt), '审批失效记录入账');
assert.ok(ledger.some((e) => e.kind === 'execution' && /api-gateway/.test(e.text)));

console.log('OK 全部断言通过：');
console.log(' 1. 补传双时间戳（at 发生 / receivedAt 补传），首次部分失败，重试只写缺失条目，重复不再记');
console.log(' 2. 晚到事件改变结论 → 原审批失效、退回待确认、需重新审批；无关动作不受影响');
console.log(' 3. 隔离按受影响资产逐个落地，失败项单独列出，重试跳过已隔离资产');
console.log(' 4. 主事件时间线/处置动作/审批按发生时间对账，补传时刻另记');
