import type {
  ApprovalRecord,
  AssetResult,
  ExecutionRecord,
  Incident,
  ResponseAction,
  TimelineEvent
} from './store';

export interface IngestibleEvent {
  id: string;
  /** 事件实际发生时间（断网期间产生） */
  at: string;
  actor: string;
  text: string;
  sensitive?: boolean;
  /** 晚到事件是否改变已有结论 */
  changesConclusion?: boolean;
  /** 结论变化后，哪些处置动作的原审批随之失效 */
  invalidatesActionIds?: string[];
}

/** 断网期间攒下、回网后一次补传的告警（发生时间均早于已完成的隔离审批） */
export const OFFLINE_BATCH: IngestibleEvent[] = (() => {
  const base = new Date();
  const ago = (minutes: number) => new Date(base.getTime() - minutes * 60_000).toISOString();
  return [
    { id: 'bf-1', at: ago(40), actor: '告警平台', text: '断网前缓冲：异常凭证首次在异地认证成功' },
    {
      id: 'bf-2',
      at: ago(28),
      actor: 'EDR 代理（缓存）',
      text: '缓存取证确认：customer-portal 会话经跳板机合法运维通道发起，初判失陷结论被推翻',
      changesConclusion: true,
      invalidatesActionIds: ['act-1']
    },
    { id: 'bf-3', at: ago(29), actor: '流量探针（缓存）', text: '断网期间流量无横向移动迹象，未发现额外受影响资产' }
  ];
})();

/** 首次补传时模拟写失败的条目（补传失败后只重试没写进的几条） */
export const FIRST_PUSH_FAILURE: Record<string, string> = {
  'bf-2': '链路重连后写入超时，事件未持久化',
  'bf-3': '链路重连后写入超时，事件未持久化'
};

export interface IngestOutcome {
  incident: Incident;
  ingested: TimelineEvent[];
  duplicates: string[];
}

let seq = 0;
const uid = (prefix: string) => `${prefix}-${Date.now()}-${(seq += 1)}`;

/**
 * 补传写入（幂等）：
 * - 按事件 id 去重，重复到达的不再记账；
 * - 补传时刻记在 receivedAt，与发生时间 at 分开；
 * - 晚到事件改变结论时，相关动作的有效审批整体失效并退回待确认。
 */
export function ingestEvents(incident: Incident, events: IngestibleEvent[], receivedAt: string): IngestOutcome {
  const knownIds = new Set(incident.timeline.map((event) => event.id));
  const ingested: TimelineEvent[] = [];
  const duplicates: string[] = [];

  for (const event of events) {
    if (knownIds.has(event.id)) {
      duplicates.push(event.id);
      continue;
    }
    knownIds.add(event.id);
    ingested.push({
      id: event.id,
      at: event.at,
      receivedAt,
      actor: event.actor,
      text: event.text,
      sensitive: event.sensitive,
      backfilled: true,
      changesConclusion: event.changesConclusion
    });
  }

  if (ingested.length === 0) {
    return { incident, ingested, duplicates };
  }

  const conclusionEventIds = new Set(ingested.filter((event) => event.changesConclusion).map((event) => event.id));
  const invalidatedActionIds = new Set<string>();
  for (const event of ingested) {
    const source = events.find((item) => item.id === event.id);
    if (source?.changesConclusion) {
      for (const actionId of source.invalidatesActionIds ?? []) invalidatedActionIds.add(actionId);
    }
  }

  const approvals: ApprovalRecord[] = incident.approvals.map((record) => {
    if (record.state !== 'valid' || !invalidatedActionIds.has(record.actionId)) return record;
    const sourceId = [...conclusionEventIds][0];
    return {
      ...record,
      state: 'invalidated',
      invalidatedAt: receivedAt,
      invalidatedReason: '晚到补传事件改变结论，原审批失效，退回待确认',
      sourceEventId: sourceId
    };
  });

  const actions: ResponseAction[] = incident.actions.map((action) => {
    if (!invalidatedActionIds.has(action.id)) return action;
    const sourceId = [...conclusionEventIds][0];
    return {
      ...action,
      approvals: [],
      status: 'pending',
      invalidatedAt: receivedAt,
      invalidatedReason: '晚到补传事件改变结论，原审批失效，退回待确认',
      sourceEventId: sourceId
    };
  });

  return {
    incident: { ...incident, timeline: [...incident.timeline, ...ingested], approvals, actions },
    ingested,
    duplicates
  };
}

/** 资产首次/重试隔离的落地结果。audit-log 的隔离通道不可用，表现为持续失败。 */
function attemptAsset(result: AssetResult, at: string): AssetResult {
  if (result.status === 'isolated') return result; // 重试时跳过已隔离资产
  if (result.asset === 'audit-log') {
    return { ...result, attempts: result.attempts + 1, status: 'failed', lastError: '隔离通道不可用：审计资产仅允许只读，需人工介入', at };
  }
  if (result.asset === 'api-gateway' && result.attempts === 0) {
    return { ...result, attempts: 1, status: 'failed', lastError: '隔离指令超时，Agent 未确认', at };
  }
  return { ...result, attempts: result.attempts + 1, status: 'isolated', at };
}

function isPending(result: AssetResult) { return result.status === 'pending'; }
function isFailed(result: AssetResult) { return result.status === 'failed'; }
function isIsolated(result: AssetResult) { return result.status === 'isolated'; }

/** 隔离动作：按受影响资产逐个落地；只尝试 pending 的资产，已隔离的跳过，失败项单独列出 */
export function landIsolation(action: ResponseAction, at: string) {
  const records: ExecutionRecord[] = [];
  const results = (action.assetResults ?? []).map((result) => {
    if (!isPending(result)) return result;
    const next = attemptAsset(result, at);
    records.push(toRecord(action.id, next, at, false));
    return next;
  });
  return { action: withIsolationStatus({ ...action, assetResults: results }), records };
}

/** 重试：只重试失败项；已隔离资产自动跳过 */
export function retryFailedIsolation(action: ResponseAction, at: string) {
  const records: ExecutionRecord[] = [];
  const results = (action.assetResults ?? []).map((result) => {
    if (!isFailed(result)) return result; // pending 不在本次重试范围；isolated 跳过
    const next = attemptAsset(result, at);
    records.push(toRecord(action.id, next, at, true));
    return next;
  });
  return { action: withIsolationStatus({ ...action, assetResults: results }), records };
}

function toRecord(actionId: string, result: AssetResult, at: string, retry: boolean): ExecutionRecord {
  const ok = isIsolated(result);
  return {
    id: uid('ex'),
    actionId,
    asset: result.asset,
    at,
    result: ok ? 'success' : 'failed',
    detail: ok
      ? `${retry ? '重试成功' : '资产'}：${result.asset} 已隔离`
      : `${retry ? '重试仍失败' : '资产隔离失败'}：${result.asset}：${result.lastError}`
  };
}

function withIsolationStatus(action: ResponseAction): ResponseAction {
  const results = action.assetResults ?? [];
  if (results.length > 0 && results.every(isIsolated)) return { ...action, status: 'executed' };
  if (results.some(isIsolated)) return { ...action, status: 'partial' }; // 部分资产落地，失败项单独列出
  return action;
}
