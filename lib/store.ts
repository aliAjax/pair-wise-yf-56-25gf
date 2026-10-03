import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Severity = 'medium' | 'high' | 'critical';
export type ActionKind = 'isolate' | 'block' | 'restore' | 'notify';
export type ActionStatus = 'pending' | 'approved' | 'executed';
export type TimelineKind = 'alert' | 'approval' | 'execution' | 'subincident' | 'system';

export interface TimelineEvent {
  id: string;
  at: string;          // 发生时间（事件实际发生时刻）
  receivedAt: string;  // 收到/补传时刻（值班室入账时刻）
  actor: string;
  text: string;
  sensitive?: boolean;
  kind: TimelineKind;
  backfilled?: boolean;  // 是否断网期间攒下、回网后补传
  dedupKey?: string;     // 幂等键：补传时据此去重，重复的不再记
}

export interface SubIncident { id: string; title: string; owner: string; status: 'open' | 'contained' | 'closed'; }

// 隔离按受影响资产逐个落地的状态
export interface IsolateTarget {
  asset: string;
  status: 'pending' | 'isolated' | 'failed';
  attempts: number;
  error?: string;
}

export interface ResponseAction {
  id: string;
  title: string;
  kind: ActionKind;
  approvals: string[];
  status: ActionStatus;
  sensitive?: boolean;
  targets?: IsolateTarget[];       // kind === 'isolate'：按受影响资产逐个落地
  invalidated?: boolean;           // 晚到事件改变结论后，原审批失效退回待确认
  invalidatedReason?: string;
  invalidatedAt?: string;
}

// 断网期间攒下的告警，回网后一次补传
export interface BackfillEventInput {
  dedupKey: string;
  at: string;
  actor: string;
  text: string;
  newAffected?: string[];  // 晚到事件给出的结论：新增受影响资产
  failOnce?: boolean;      // 模拟首次补传写入失败，重试时成功
}

export interface BackfillFailure {
  dedupKey: string;
  at: string;
  actor: string;
  text: string;
  newAffected?: string[];
  failOnce?: boolean;
  attempts: number;
  error: string;
}

export interface Incident {
  id: string; title: string; severity: Severity; status: 'investigating' | 'contained' | 'recovered';
  affected: string[];
  subIncidents: SubIncident[];
  actions: ResponseAction[];
  timeline: TimelineEvent[];
  backfillFailures: BackfillFailure[];  // 补传失败、待重试的几条
  lastBackfill?: { at: string; written: number; duplicated: number; failed: number };
}

interface State {
  incident: Incident;
  role: 'analyst' | 'responder' | 'legal' | 'viewer';
  demoMode: boolean;
  setRole: (role: State['role']) => void;
  toggleDemo: () => void;
  addSubIncident: (payload: { title: string; owner: string }) => void;
  approveAction: (id: string) => void;
  executeAction: (id: string) => void;
  reorderActions: (activeId: string, overId: string) => void;
  backfillEvents: (events: BackfillEventInput[]) => void;
  retryBackfill: () => void;
  tick: () => void;
}

const now = () => new Date().toISOString();
const genId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// 模拟隔离代理：指定资产首次落地超时，重试成功
const TRANSIENT_FAIL_ASSET = 'audit-log';

function makeIsolateTargets(assets: string[]): IsolateTarget[] {
  return assets.map((asset) => ({ asset, status: 'pending', attempts: 0 }));
}

// 晚到补传事件改变结论（影响范围）：扩大受影响资产，
// 已批准但未落地的隔离审批失去依据、退回待确认；已隔离的资产保留。
function applyConclusionChange(incident: Incident, newAffected: string[]): { incident: Incident; changed: boolean } {
  const known = new Set(incident.affected);
  const added = newAffected.filter((asset) => !known.has(asset));
  if (added.length === 0) return { incident, changed: false };
  const affected = [...incident.affected, ...added];
  const actions = incident.actions.map((action) => {
    if (action.kind !== 'isolate') return action;
    const prevTargets = action.targets ?? makeIsolateTargets(incident.affected);
    const targets: IsolateTarget[] = [
      ...prevTargets.map((target) => ({ ...target })),
      ...added.map((asset) => ({ asset, status: 'pending' as const, attempts: 0 }))
    ];
    // 结论变化：原隔离审批失效，退回待确认（已隔离资产状态保留，重试时跳过）
    return {
      ...action,
      targets,
      status: 'pending' as ActionStatus,
      approvals: [],
      invalidated: true,
      invalidatedAt: now(),
      invalidatedReason: `晚到补传事件更新结论：影响范围扩大至 ${added.join('、')}，原隔离审批依据的结论已变化`
    };
  });
  return { incident: { ...incident, affected, actions }, changed: true };
}

const initial: Incident = {
  id: 'INC-2026-0929', title: '对外网关异常凭证使用', severity: 'critical', status: 'investigating', affected: ['api-gateway', 'customer-portal', 'audit-log'],
  subIncidents: [
    { id: 'sub-1', title: '异常会话来源分析', owner: '分析组', status: 'open' },
    { id: 'sub-2', title: '受影响租户范围确认', owner: '平台组', status: 'open' }
  ],
  actions: [
    { id: 'act-1', title: '隔离异常网关节点', kind: 'isolate', approvals: [], status: 'pending', sensitive: true, targets: makeIsolateTargets(['api-gateway', 'customer-portal', 'audit-log']) },
    { id: 'act-2', title: '封禁可疑出口地址', kind: 'block', approvals: [], status: 'pending' },
    { id: 'act-3', title: '准备客户披露口径', kind: 'notify', approvals: ['legal'], status: 'pending', sensitive: true }
  ],
  timeline: [
    { id: 'e1', at: new Date(Date.now() - 1500000).toISOString(), receivedAt: new Date(Date.now() - 1500000).toISOString(), actor: '告警平台', text: '检测到同一凭证跨三个地域登录', sensitive: true, kind: 'alert', dedupKey: 'cred-login-geo' },
    { id: 'e2', at: new Date(Date.now() - 900000).toISOString(), receivedAt: new Date(Date.now() - 900000).toISOString(), actor: '值班分析员', text: '确认会话未经过常规办公出口', kind: 'alert' }
  ],
  backfillFailures: []
};

export const useIncidentStore = create<State>()(persist((set, get) => ({
  incident: initial, role: 'analyst', demoMode: false,
  setRole: (role) => set({ role }),
  toggleDemo: () => set((state) => ({ demoMode: !state.demoMode })),
  addSubIncident: (payload) => { if (get().demoMode) return; const ts = now(); set((state) => ({ incident: { ...state.incident, subIncidents: [...state.incident.subIncidents, { id: `sub-${Date.now()}`, ...payload, status: 'open' }], timeline: [{ id: genId('e'), at: ts, receivedAt: ts, actor: '响应负责人', text: `创建子事件：${payload.title}`, kind: 'subincident' }, ...state.incident.timeline] } })); },
  approveAction: (id) => { if (get().demoMode) return; const state = get(); const action = state.incident.actions.find((item) => item.id === id); if (!action || action.approvals.includes(state.role) || state.role === 'viewer') return; const ts = now(); set({ incident: { ...state.incident, actions: state.incident.actions.map((item) => item.id === id ? { ...item, approvals: [...item.approvals, state.role], status: item.approvals.length >= 1 && action.kind === 'isolate' ? 'approved' : item.status, invalidated: false, invalidatedReason: undefined, invalidatedAt: undefined } : item), timeline: [{ id: genId('e'), at: ts, receivedAt: ts, actor: state.role, text: `审批处置动作：${action.title}`, kind: 'approval' }, ...state.incident.timeline] } }); },
  executeAction: (id) => {
    const state = get();
    const action = state.incident.actions.find((item) => item.id === id);
    if (!action || state.demoMode || state.role === 'viewer' || (action.kind === 'isolate' && action.approvals.length < 2)) return;
    const ts = now();
    let actions = state.incident.actions;
    let timeline = state.incident.timeline;
    if (action.kind === 'isolate' && action.targets) {
      // 隔离按受影响资产逐个落地：已隔离的资产重试时跳过
      const targets = action.targets.map((target) => {
        if (target.status === 'isolated') return target;
        const attempts = target.attempts + 1;
        if (attempts === 1 && target.asset === TRANSIENT_FAIL_ASSET) {
          return { ...target, attempts, status: 'failed' as const, error: '隔离代理返回超时（模拟）' };
        }
        return { ...target, attempts, status: 'isolated' as const, error: undefined };
      });
      const isolatedCount = targets.filter((target) => target.status === 'isolated').length;
      const allIsolated = isolatedCount === targets.length;
      actions = actions.map((item) => item.id === id ? { ...item, targets, status: allIsolated ? 'executed' : 'approved' } : item);
      timeline = [{ id: genId('e'), at: ts, receivedAt: ts, actor: state.role, kind: 'execution', sensitive: action.sensitive, text: allIsolated ? `执行处置动作：${action.title}（${targets.length} 项资产已全部隔离）` : `执行处置动作：${action.title}（${isolatedCount}/${targets.length} 项资产已隔离，失败项待重试）` }, ...timeline];
    } else {
      actions = actions.map((item) => item.id === id ? { ...item, status: 'executed' } : item);
      timeline = [{ id: genId('e'), at: ts, receivedAt: ts, actor: state.role, kind: 'execution', text: `执行处置动作：${action.title}`, sensitive: action.sensitive }, ...timeline];
    }
    set({ incident: { ...state.incident, actions, timeline } });
  },
  reorderActions: (activeId, overId) => { const state = get(); const actions = [...state.incident.actions]; const from = actions.findIndex((item) => item.id === activeId); const to = actions.findIndex((item) => item.id === overId); if (from < 0 || to < 0 || state.demoMode) return; const [moved] = actions.splice(from, 1); actions.splice(to, 0, moved); set({ incident: { ...state.incident, actions } }); },
  backfillEvents: (events) => {
    if (get().demoMode) return;
    const state = get();
    const receivedAt = now();  // 补传时刻：本批事件统一入账时刻
    const known = new Set(state.incident.timeline.filter((event) => event.dedupKey).map((event) => event.dedupKey as string));
    const failures: BackfillFailure[] = [];
    const incoming: TimelineEvent[] = [];
    let duplicated = 0;
    let incident = state.incident;
    for (const input of events) {
      if (known.has(input.dedupKey)) { duplicated += 1; continue; }  // 重复的不再记
      if (input.failOnce) { failures.push({ ...input, attempts: 1, error: '补传写入超时（模拟）' }); continue; }  // 没写进的几条
      incoming.push({ id: genId('e'), at: input.at, receivedAt, actor: input.actor, text: input.text, kind: 'alert', backfilled: true, dedupKey: input.dedupKey });
      known.add(input.dedupKey);
      if (input.newAffected?.length) {
        const result = applyConclusionChange(incident, input.newAffected);
        incident = result.incident;
        if (result.changed) incoming.push({ id: genId('e'), at: now(), receivedAt, actor: '系统', kind: 'system', text: '晚到补传事件更新结论：影响范围扩大，原隔离审批失效退回待确认' });
      }
    }
    const written = incoming.filter((event) => event.kind === 'alert').length;
    set({ incident: { ...incident, timeline: [...incoming, ...incident.timeline], backfillFailures: failures, lastBackfill: { at: receivedAt, written, duplicated, failed: failures.length } } });
  },
  retryBackfill: () => {
    if (get().demoMode) return;
    const state = get();
    const queued = state.incident.backfillFailures;
    if (queued.length === 0) return;
    const receivedAt = now();  // 重试补传时刻
    const known = new Set(state.incident.timeline.filter((event) => event.dedupKey).map((event) => event.dedupKey as string));
    const remaining: BackfillFailure[] = [];
    const incoming: TimelineEvent[] = [];
    let duplicated = 0;
    let recovered = 0;
    let incident = state.incident;
    for (const failure of queued) {
      if (known.has(failure.dedupKey)) { duplicated += 1; continue; }  // 重试时重复的不再记
      const attempts = failure.attempts + 1;
      if (failure.failOnce && attempts < 2) { remaining.push({ ...failure, attempts, error: '补传写入超时（模拟）' }); continue; }
      incoming.push({ id: genId('e'), at: failure.at, receivedAt, actor: failure.actor, text: failure.text, kind: 'alert', backfilled: true, dedupKey: failure.dedupKey });
      known.add(failure.dedupKey);
      recovered += 1;
      if (failure.newAffected?.length) {
        const result = applyConclusionChange(incident, failure.newAffected);
        incident = result.incident;
        if (result.changed) incoming.push({ id: genId('e'), at: now(), receivedAt, actor: '系统', kind: 'system', text: '补传重试成功并更新结论：影响范围扩大，原隔离审批失效退回待确认' });
      }
    }
    set({ incident: { ...incident, timeline: [...incoming, ...incident.timeline], backfillFailures: remaining, lastBackfill: { at: receivedAt, written: recovered, duplicated, failed: remaining.length } } });
  },
  tick: () => set((state) => { const ts = now(); return { incident: { ...state.incident, timeline: [{ id: genId('e'), at: ts, receivedAt: ts, actor: '监测代理', text: `实时检查：${state.incident.affected.length} 项资产状态已更新`, kind: 'system' as const }, ...state.incident.timeline].slice(0, 30) } }; })
}), { name: 'yf56-incident-store' }));

export interface LedgerEntry {
  id: string;
  at: string;
  recordedAt: string;
  kind: TimelineKind;
  actor: string;
  text: string;
  backfilled?: boolean;
  dedupKey?: string;
}

// 对账：主事件时间线、处置动作与审批记录按发生时间（at）排序，补传时刻另记
export function buildLedger(incident: Incident): LedgerEntry[] {
  return incident.timeline
    .map((event) => ({ id: event.id, at: event.at, recordedAt: event.receivedAt, kind: event.kind, actor: event.actor, text: event.text, backfilled: event.backfilled, dedupKey: event.dedupKey }))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

// 主时间线按收到顺序（receivedAt 倒序）展示；同一批补传按入账顺序排列
export function receivedTimeline(incident: Incident): TimelineEvent[] {
  return [...incident.timeline].sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
}
