import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  FIRST_PUSH_FAILURE,
  OFFLINE_BATCH,
  ingestEvents,
  landIsolation,
  retryFailedIsolation,
  type IngestibleEvent
} from './incident-logic';

export type Role = 'analyst' | 'responder' | 'legal' | 'viewer';
export type Severity = 'medium' | 'high' | 'critical';

/** 时间线事件：at=发生时间（对账依据），receivedAt=到达/写入时间（补传时刻另记） */
export interface TimelineEvent {
  id: string;
  at: string;
  receivedAt: string;
  actor: string;
  text: string;
  sensitive?: boolean;
  backfilled?: boolean;
  changesConclusion?: boolean;
}

/** 审批记录：失效后保留原记录并退回待确认，重新审批另写新记录 */
export interface ApprovalRecord {
  id: string;
  actionId: string;
  role: Role;
  at: string;
  state: 'valid' | 'invalidated';
  invalidatedAt?: string;
  invalidatedReason?: string;
  sourceEventId?: string;
}

/** 隔离按受影响资产逐个落地的结果 */
export interface AssetResult {
  asset: string;
  status: 'pending' | 'isolated' | 'failed';
  attempts: number;
  lastError?: string;
  at?: string;
}

export interface ExecutionRecord {
  id: string;
  actionId: string;
  asset?: string;
  at: string;
  result: 'success' | 'failed';
  detail: string;
}

export interface ResponseAction {
  id: string;
  title: string;
  kind: 'isolate' | 'block' | 'restore' | 'notify';
  approvals: Role[];
  status: 'pending' | 'approved' | 'partial' | 'executed';
  sensitive?: boolean;
  assetResults?: AssetResult[];
  invalidatedAt?: string;
  invalidatedReason?: string;
  sourceEventId?: string;
}

export interface Incident {
  id: string;
  title: string;
  severity: Severity;
  status: 'investigating' | 'contained' | 'recovered';
  affected: string[];
  subIncidents: SubIncident[];
  actions: ResponseAction[];
  timeline: TimelineEvent[];
  approvals: ApprovalRecord[];
  executions: ExecutionRecord[];
}

export interface SubIncident { id: string; title: string; owner: string; status: 'open' | 'contained' | 'closed'; }

export interface BackfillFailure { id: string; reason: string; attempts: number; }
export interface BackfillState {
  status: 'idle' | 'partial' | 'complete';
  startedAt: string | null;
  total: number;
  /** 已写入事件 id：补传/重试的幂等依据，重复到达不再记账 */
  writtenIds: string[];
  /** 本次没写进的几条，重试只针对它们 */
  failed: BackfillFailure[];
  duplicatesSkipped: number;
}

interface State {
  incident: Incident;
  role: Role;
  demoMode: boolean;
  backfill: BackfillState;
  setRole: (role: Role) => void;
  toggleDemo: () => void;
  addSubIncident: (payload: { title: string; owner: string }) => void;
  approveAction: (id: string) => void;
  executeAction: (id: string) => void;
  retryIsolation: (id: string) => void;
  runBackfill: () => void;
  retryBackfill: () => void;
  reorderActions: (activeId: string, overId: string) => void;
  tick: () => void;
}

const nowIso = () => new Date().toISOString();
export const requiredApprovals = (action: ResponseAction) => (action.kind === 'isolate' ? 2 : 1);

function createInitialIncident(): Incident {
  const ref = Date.now();
  const ago = (minutes: number) => new Date(ref - minutes * 60_000).toISOString();
  const affected = ['api-gateway', 'customer-portal', 'audit-log'];
  return {
    id: 'INC-2026-0929',
    title: '对外网关异常凭证使用',
    severity: 'critical',
    status: 'investigating',
    affected,
    subIncidents: [
      { id: 'sub-1', title: '异常会话来源分析', owner: '分析组', status: 'open' },
      { id: 'sub-2', title: '受影响租户范围确认', owner: '平台组', status: 'open' }
    ],
    actions: [
      {
        id: 'act-1',
        title: '隔离异常凭证关联资产',
        kind: 'isolate',
        approvals: ['analyst', 'responder'],
        status: 'approved',
        sensitive: true,
        assetResults: affected.map((asset) => ({ asset, status: 'pending', attempts: 0 }))
      },
      { id: 'act-2', title: '封禁可疑出口地址', kind: 'block', approvals: [], status: 'pending' },
      { id: 'act-3', title: '准备客户披露口径', kind: 'notify', approvals: ['legal'], status: 'approved', sensitive: true }
    ],
    timeline: [
      { id: 'e1', at: ago(35), receivedAt: ago(35), actor: '告警平台', text: '检测到同一凭证跨三个地域登录', sensitive: true },
      { id: 'e2', at: ago(30), receivedAt: ago(30), actor: '值班分析员', text: '确认会话未经过常规办公出口' }
    ],
    approvals: [
      { id: 'ap-1', actionId: 'act-1', role: 'analyst', at: ago(26), state: 'valid' },
      { id: 'ap-2', actionId: 'act-1', role: 'responder', at: ago(24), state: 'valid' },
      { id: 'ap-3', actionId: 'act-3', role: 'legal', at: ago(22), state: 'valid' }
    ],
    executions: []
  };
}

function createInitialState() {
  return {
    incident: createInitialIncident(),
    role: 'analyst' as Role,
    demoMode: false,
    backfill: { status: 'idle' as const, startedAt: null, total: OFFLINE_BATCH.length, writtenIds: [], failed: [], duplicatesSkipped: 0 }
  };
}

export const useIncidentStore = create<State>()(persist((set, get) => ({
  ...createInitialState(),

  setRole: (role) => set({ role }),
  toggleDemo: () => set((state) => ({ demoMode: !state.demoMode })),

  addSubIncident: (payload) => {
    if (get().demoMode) return;
    const at = nowIso();
    set((state) => ({
      incident: {
        ...state.incident,
        subIncidents: [...state.incident.subIncidents, { id: `sub-${Date.now()}`, ...payload, status: 'open' }],
        timeline: [...state.incident.timeline, { id: `e-${Date.now()}`, at, receivedAt: at, actor: '响应负责人', text: `创建子事件：${payload.title}` }]
      }
    }));
  },

  approveAction: (id) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const action = state.incident.actions.find((item) => item.id === id);
    if (!action || action.status === 'executed' || action.approvals.includes(state.role)) return;
    const at = nowIso();
    const approvals = [...action.approvals, state.role];
    const record: ApprovalRecord = { id: `ap-${Date.now()}`, actionId: id, role: state.role, at, state: 'valid' };
    set({
      incident: {
        ...state.incident,
        actions: state.incident.actions.map((item) => item.id === id
          ? { ...item, approvals, status: approvals.length >= requiredApprovals(item) ? 'approved' : 'pending', invalidatedAt: undefined, invalidatedReason: undefined, sourceEventId: undefined }
          : item),
        approvals: [...state.incident.approvals, record]
      }
    });
  },

  executeAction: (id) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const action = state.incident.actions.find((item) => item.id === id);
    if (!action || action.status !== 'approved') return;
    const at = nowIso();
    if (action.kind === 'isolate') {
      // 隔离按受影响资产逐个落地；只尝试尚未隔离的资产，已隔离的跳过
      const { action: landed, records } = landIsolation(action, at);
      set({
        incident: {
          ...state.incident,
          actions: state.incident.actions.map((item) => (item.id === id ? landed : item)),
          executions: [...state.incident.executions, ...records]
        }
      });
      return;
    }
    const record: ExecutionRecord = { id: `ex-${Date.now()}`, actionId: id, at, result: 'success', detail: `执行处置动作：${action.title}` };
    set({
      incident: {
        ...state.incident,
        actions: state.incident.actions.map((item) => (item.id === id ? { ...item, status: 'executed' } : item)),
        executions: [...state.incident.executions, record]
      }
    });
  },

  retryIsolation: (id) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const action = state.incident.actions.find((item) => item.id === id);
    if (!action || !action.assetResults?.some((item) => item.status === 'failed')) return;
    // 只重试失败项；已隔离资产自动跳过
    const { action: retried, records } = retryFailedIsolation(action, nowIso());
    set({
      incident: {
        ...state.incident,
        actions: state.incident.actions.map((item) => (item.id === id ? retried : item)),
        executions: [...state.incident.executions, ...records]
      }
    });
  },

  // 回网后一次性补传断网期间攒下的告警：模拟部分事件首次写不进
  runBackfill: () => {
    const state = get();
    if (state.demoMode || state.backfill.status !== 'idle') return;
    const receivedAt = nowIso();
    const toWrite: IngestibleEvent[] = [];
    const failed: BackfillFailure[] = [];
    for (const event of OFFLINE_BATCH) {
      const reason = FIRST_PUSH_FAILURE[event.id];
      if (reason) failed.push({ id: event.id, reason, attempts: 1 });
      else toWrite.push(event);
    }
    const { incident, ingested } = ingestEvents(state.incident, toWrite, receivedAt);
    set({
      incident,
      backfill: {
        status: failed.length ? 'partial' : 'complete',
        startedAt: receivedAt,
        total: OFFLINE_BATCH.length,
        writtenIds: ingested.map((event) => event.id),
        failed,
        duplicatesSkipped: 0
      }
    });
  },

  // 补传重试：整批重放，由幂等逻辑保证只有没写进的几条落库，重复的不再记
  retryBackfill: () => {
    const state = get();
    if (state.demoMode || state.backfill.status !== 'partial') return;
    const receivedAt = nowIso();
    const { incident, ingested, duplicates } = ingestEvents(state.incident, OFFLINE_BATCH, receivedAt);
    set({
      incident,
      backfill: {
        status: 'complete',
        startedAt: state.backfill.startedAt ?? receivedAt,
        total: state.backfill.total,
        writtenIds: [...state.backfill.writtenIds, ...ingested.map((event) => event.id)],
        failed: [],
        duplicatesSkipped: state.backfill.duplicatesSkipped + duplicates.length
      }
    });
  },

  reorderActions: (activeId, overId) => {
    const state = get();
    const actions = [...state.incident.actions];
    const from = actions.findIndex((item) => item.id === activeId);
    const to = actions.findIndex((item) => item.id === overId);
    if (from < 0 || to < 0 || state.demoMode) return;
    const [moved] = actions.splice(from, 1);
    actions.splice(to, 0, moved);
    set({ incident: { ...state.incident, actions } });
  },

  tick: () => set((state) => {
    const at = nowIso();
    return {
      incident: {
        ...state.incident,
        timeline: [...state.incident.timeline, {
          id: `e-${Date.now()}`,
          at,
          receivedAt: at,
          actor: '监测代理',
          text: `实时检查：${state.incident.affected.length} 项资产状态已更新`
        }].slice(-40)
      }
    };
  })
}), {
  name: 'yf56-incident-store',
  version: 2,
  migrate: (persisted: unknown) => {
    const p = (persisted ?? {}) as Partial<State>;
    return { ...createInitialState(), role: p.role ?? 'analyst', demoMode: p.demoMode ?? false };
  }
}));
