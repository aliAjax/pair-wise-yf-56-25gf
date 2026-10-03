import type { Incident } from './store';

export type LedgerKind = 'event' | 'approval' | 'invalidation' | 'execution';

export interface LedgerEntry {
  key: string;
  kind: LedgerKind;
  /** 对账主键：发生时间（不是补传/到达时间） */
  at: string;
  actor: string;
  text: string;
  sensitive?: boolean;
  actionId?: string;
  /** 事件的补传/到达时刻，补传事件另记；实时事件与发生时间相同 */
  receivedAt?: string;
  backfilled?: boolean;
  changesConclusion?: boolean;
}

const KIND_RANK: Record<LedgerKind, number> = { event: 0, approval: 1, invalidation: 2, execution: 3 };
const KIND_LABEL: Record<LedgerKind, string> = { event: '事件', approval: '审批', invalidation: '审批失效', execution: '执行' };

/**
 * 对账台账：把主事件时间线、处置动作执行记录、审批记录按“发生时间”归并排序。
 * 补传时刻（receivedAt）单独保留，不参与排序——页面按收到顺序展示只用于实时流。
 */
export function buildLedger(incident: Incident): LedgerEntry[] {
  const actionTitle = new Map(incident.actions.map((action) => [action.id, action.title]));
  const roleName: Record<string, string> = { analyst: '分析员', responder: '响应负责人', legal: '法务/公关', legal2: '法务/公关' };

  const entries: LedgerEntry[] = [];

  for (const event of incident.timeline) {
    entries.push({
      key: `event-${event.id}`,
      kind: 'event',
      at: event.at,
      receivedAt: event.receivedAt,
      actor: event.actor,
      text: event.text,
      sensitive: event.sensitive,
      backfilled: event.backfilled,
      changesConclusion: event.changesConclusion
    });
  }

  for (const record of incident.approvals) {
    const title = actionTitle.get(record.actionId) ?? record.actionId;
    entries.push({
      key: `approval-${record.id}`,
      kind: 'approval',
      at: record.at,
      actor: roleName[record.role] ?? record.role,
      text: `审批通过：${title}`,
      actionId: record.actionId
    });
    if (record.state === 'invalidated' && record.invalidatedAt) {
      entries.push({
        key: `invalidation-${record.id}`,
        kind: 'invalidation',
        at: record.invalidatedAt,
        actor: '系统',
        text: `原审批失效退回待确认：${title}（${record.invalidatedReason ?? '结论变化'}）`,
        actionId: record.actionId,
        changesConclusion: true
      });
    }
  }

  for (const record of incident.executions) {
    const title = actionTitle.get(record.actionId) ?? record.actionId;
    entries.push({
      key: `execution-${record.id}`,
      kind: 'execution',
      at: record.at,
      actor: '执行平台',
      text: record.asset ? `${record.result === 'success' ? '✓' : '✗'} ${record.detail}` : record.detail || `执行：${title}`,
      actionId: record.actionId
    });
  }

  return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : KIND_RANK[a.kind] - KIND_RANK[b.kind]));
}

export const ledgerKindLabel = KIND_LABEL;
