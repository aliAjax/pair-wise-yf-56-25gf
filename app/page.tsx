'use client';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { AlertTriangle, CheckCircle2, CloudUpload, Eye, Radio, ShieldAlert, UserCheck, Users, XCircle } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { OFFLINE_BATCH } from '@/lib/incident-logic';
import { buildLedger, ledgerKindLabel } from '@/lib/reconciliation';
import { useIncidentStore, requiredApprovals, type ResponseAction } from '@/lib/store';

const formSchema = z.object({ title: z.string().min(4, '请填写至少4个字的子事件'), owner: z.string().min(2, '请填写负责组') });
const roleNames = { analyst: '分析员', responder: '响应负责人', legal: '法务/公关', viewer: '访客' };
const kindNames: Record<ResponseAction['kind'], string> = { isolate: '隔离', block: '封禁', restore: '恢复', notify: '通报' };
const statusNames: Record<ResponseAction['status'], string> = { pending: '待确认', approved: '已批准待执行', partial: '部分落地', executed: '已执行' };
const hm = (iso: string) => format(new Date(iso), 'MM-dd HH:mm:ss');

function SortableAction({ action }: { action: ResponseAction }) {
  const store = useIncidentStore();
  const sortable = useSortable({ id: action.id });
  const canSee = !action.sensitive || ['responder', 'legal'].includes(store.role);
  const frozen = store.demoMode || store.role === 'viewer';
  const assets = action.assetResults ?? [];
  const isolated = assets.filter((item) => item.status === 'isolated');
  const failed = assets.filter((item) => item.status === 'failed');
  const history = store.incident.approvals.filter((item) => item.actionId === action.id);
  const readyToApprove = action.status !== 'executed' && action.approvals.length < requiredApprovals(action);

  return (
    <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} className="action-row">
      <div className="action-main">
        <strong>{canSee ? action.title : '敏感处置动作（当前角色不可见）'}</strong>
        <div className="muted">{kindNames[action.kind]} · 有效审批 {action.approvals.length}/{requiredApprovals(action)} · {statusNames[action.status]}</div>

        {action.invalidatedAt && (
          <div className="invalid-banner"><AlertTriangle size={14} />晚到的补传事件改变了结论，原审批已于 {hm(action.invalidatedAt)} 失效，动作退回待确认，需重新审批。</div>
        )}

        {history.length > 0 && (
          <div className="approval-history">
            {history.map((record) => (
              <span key={record.id} className={`approval-chip ${record.state}`} title={hm(record.at)}>
                {record.state === 'valid' ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                {roleNames[record.role]} · {hm(record.at)}{record.state === 'invalidated' ? ' · 已失效' : ''}
              </span>
            ))}
          </div>
        )}

        {canSee && assets.length > 0 && (
          <div className="asset-block">
            <div className="asset-chips">
              {assets.map((item) => (
                <span key={item.asset} className={`asset-chip ${item.status}`}>
                  {item.status === 'isolated' ? <CheckCircle2 size={12} /> : item.status === 'failed' ? <XCircle size={12} /> : <AlertTriangle size={12} />}
                  {item.asset}
                </span>
              ))}
            </div>
            <div className="muted">已隔离 {isolated.length}/{assets.length}{failed.length > 0 && <> · 失败项单独列出：{failed.map((item) => item.asset).join('、')}</>}</div>
            {failed.length > 0 && <ul className="fail-list">{failed.map((item) => <li key={item.asset}>{item.asset}（第 {item.attempts} 次）：{item.lastError}</li>)}</ul>}
          </div>
        )}
      </div>
      <div className="row-actions">
        {readyToApprove && <Button size="sm" variant="outline" disabled={frozen || action.approvals.includes(store.role)} onClick={() => store.approveAction(action.id)}><UserCheck size={14} />审批</Button>}
        {action.kind === 'isolate' && failed.length > 0
          ? <Button size="sm" disabled={frozen || action.status === 'pending'} onClick={() => store.retryIsolation(action.id)}>重试失败项</Button>
          : <Button size="sm" disabled={frozen || action.status !== 'approved'} onClick={() => store.executeAction(action.id)}>执行</Button>}
        <Button size="sm" variant="ghost" {...sortable.attributes} {...sortable.listeners}>排序</Button>
      </div>
    </div>
  );
}

function BackfillCard() {
  const store = useIncidentStore();
  const bf = store.backfill;
  const stateOf = (id: string): 'pending' | 'failed' | 'written' => {
    if (bf.writtenIds.includes(id)) return 'written';
    if (bf.failed.some((item) => item.id === id)) return 'failed';
    return 'pending';
  };

  return (
    <Card>
      <CardHeader>
        <div>
          <h2>断网告警补传</h2>
          <p className="muted">断网期间告警先在边缘缓存，回网后一次补传；事件按“发生时间”对账，补传时刻另记。</p>
        </div>
        <CloudUpload color="#b91c1c" />
      </CardHeader>
      <CardContent>
        <div className="backfill-status">
          <Badge className={bf.status === 'idle' ? '' : bf.status === 'partial' ? 'critical' : 'ok'}>
            {bf.status === 'idle' ? '待补传' : bf.status === 'partial' ? `部分失败（${bf.failed.length} 条未写入）` : '补传完成'}
          </Badge>
          {bf.startedAt && <span className="muted">首次补传时刻：{hm(bf.startedAt)}</span>}
          {bf.status === 'idle' && <Button size="sm" disabled={store.demoMode} onClick={store.runBackfill}>回网后一次补传（{OFFLINE_BATCH.length} 条）</Button>}
          {bf.status === 'partial' && <Button size="sm" disabled={store.demoMode} onClick={store.retryBackfill}>只重试未写入的 {bf.failed.length} 条</Button>}
          {bf.status === 'complete' && bf.failed.length === 0 && <span className="muted">已写入 {bf.writtenIds.length}/{bf.total} 条{bf.duplicatesSkipped > 0 ? `，重复到达跳过 ${bf.duplicatesSkipped} 条` : ''}</span>}
        </div>
        <ul className="backfill-list">
          {OFFLINE_BATCH.map((event) => {
            const state = stateOf(event.id);
            const failure = bf.failed.find((item) => item.id === event.id);
            const written = store.incident.timeline.find((item) => item.id === event.id);
            return (
              <li key={event.id} className={`backfill-item ${state}`}>
                <div className="backfill-head">
                  <strong>{event.actor}</strong>
                  <Badge className={state === 'failed' ? 'critical' : state === 'written' ? 'ok' : ''}>
                    {state === 'pending' ? '缓存中' : state === 'failed' ? `写入失败（第 ${failure?.attempts ?? 1} 次）` : '已写入'}
                  </Badge>
                </div>
                <p>{event.text}</p>
                <div className="muted">发生时间：{hm(event.at)}{written ? ` · 补传时刻：${hm(written.receivedAt)}` : ' · 补传时刻：—'}</div>
                {failure && <div className="fail-text">失败原因：{failure.reason}</div>}
                {event.changesConclusion && <div className="conclusion-tag"><AlertTriangle size={12} />该晚到事件改变结论，将作废旧审批</div>}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

export default function Page() {
  const t = useTranslations();
  const store = useIncidentStore();
  const incident = store.incident;
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof formSchema>>({ resolver: zodResolver(formSchema), defaultValues: { title: '', owner: '' } });
  const { data: health = { connected: false, latency: 0 } } = useQuery({ queryKey: ['live'], queryFn: async () => ({ connected: true, latency: 42 }), refetchInterval: 10000 });
  useEffect(() => { const timer = window.setInterval(() => { if (!store.demoMode) store.tick(); }, 20000); return () => window.clearInterval(timer); }, [store.demoMode]);
  function dragEnd(event: DragEndEvent) { if (event.over) store.reorderActions(String(event.active.id), String(event.over.id)); }
  const canSeeSensitive = ['responder', 'legal'].includes(store.role);

  // 实时流：严格按收到顺序（新到在前）；补传事件发生时间再早，也按补传时刻排位
  const feed = useMemo(() => [...incident.timeline].sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1)), [incident.timeline]);
  // 对账台账：主事件时间线 + 审批 + 执行，按发生时间归并（早的在前）
  const ledger = useMemo(() => buildLedger(incident), [incident]);

  const isolationAction = incident.actions.find((action) => action.kind === 'isolate');
  const assetResults = isolationAction?.assetResults ?? [];
  const isolatedCount = assetResults.filter((item) => item.status === 'isolated').length;

  return <main className="shell">
    <header className="topbar"><div><span className="eyebrow"><Radio size={14} /> LIVE WAR ROOM · PORT 62021</span><h1>{t('title')}</h1><p>{t('subtitle')}</p></div><div className="controls"><select value={store.role} onChange={(event) => store.setRole(event.target.value as typeof store.role)}>{Object.entries(roleNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><Button variant={store.demoMode ? 'danger' : 'outline'} onClick={store.toggleDemo}><Eye size={16} />{store.demoMode ? '退出演示' : t('demo')}</Button></div></header>
    {store.demoMode && <div className="demo-banner">只读演示模式已开启：审批、执行、重试、补传、拖拽和新增操作均被冻结，仍可查看允许范围内的内容。</div>}
    <section className="metrics"><Card><CardContent><span>当前事件</span><strong>{incident.id}</strong><Badge className="critical">{incident.severity}</Badge></CardContent></Card><Card><CardContent><span>实时通道</span><strong>{health.connected ? `${health.latency}ms` : '离线'}</strong><small>{health.connected ? '监测代理已连接（断网期间告警在边缘缓存）' : '等待连接'}</small></CardContent></Card><Card><CardContent><span>隔离落地</span><strong>{isolatedCount}/{assetResults.length}</strong><small>已隔离资产/受影响资产</small></CardContent></Card><Card><CardContent><span>补传告警</span><strong>{store.backfill.writtenIds.length}/{store.backfill.total}</strong><small>{store.backfill.status === 'partial' ? `${store.backfill.failed.length} 条待重试` : store.backfill.status === 'complete' ? '已全部写入' : '待补传'}</small></CardContent></Card></section>
    <section className="grid">
      <div className="stack">
        <Card><CardHeader><div><h2>事件摘要</h2><p className="muted">影响范围：{incident.affected.join(' · ')}</p></div><ShieldAlert color={incident.severity === 'critical' ? '#ef4444' : '#f59e0b'} /></CardHeader><CardContent><div className="incident-state"><span>处置阶段</span><strong>{incident.status}</strong></div><h3>子事件</h3>{incident.subIncidents.map((item) => <div className="sub-row" key={item.id}><div><strong>{item.title}</strong><div className="muted">{item.owner}</div></div><Badge>{item.status}</Badge></div>)}</CardContent></Card>
        <Card><CardHeader><div><h2>{t('approval')}</h2><p className="muted">隔离动作需两名不同角色确认，按受影响资产逐个落地；晚到事件推翻结论时原审批失效退回待确认。敏感动作仅响应和法务角色可见。</p></div><Users size={20} /></CardHeader><CardContent><DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}><SortableContext items={incident.actions.map((item) => item.id)} strategy={verticalListSortingStrategy}><div>{incident.actions.map((action) => <SortableAction key={action.id} action={action} />)}</div></SortableContext></DndContext></CardContent></Card>
      </div>
      <div className="stack">
        <BackfillCard />
        <Card><CardHeader><h2>新增子事件</h2></CardHeader><CardContent><form onSubmit={form.handleSubmit((values) => { store.addSubIncident(values); form.reset(); })}><label>子事件名称<Input {...form.register('title')} placeholder="例如：凭据轮换" /></label><small className="error">{form.formState.errors.title?.message}</small><label>负责组<Input {...form.register('owner')} placeholder="例如：平台组" /></label><small className="error">{form.formState.errors.owner?.message}</small><Button type="submit" disabled={store.demoMode}><ShieldAlert size={16} />创建子事件</Button></form></CardContent></Card>
        <Card className="timeline-card"><CardHeader><div><h2>{t('timeline')}（按收到顺序）</h2><p className="muted">页面按收到顺序排列：补传事件即使发生更早，也排在回网补传的时刻</p></div><Radio color="#ef4444" /></CardHeader><CardContent><div className="timeline">{feed.map((event) => <article key={event.id} className={event.backfilled ? 'backfilled' : ''}><i /><div><div className="timeline-meta"><strong>{event.actor}</strong><span>{formatDistanceToNow(new Date(event.receivedAt), { addSuffix: true, locale: zhCN })}</span></div><p>{event.sensitive && !canSeeSensitive ? '敏感处置记录已隐藏' : event.text}</p>{event.backfilled && <div className="backfill-meta">补传标记 · 发生 {hm(event.at)} · 补传于 {hm(event.receivedAt)}{event.changesConclusion ? ' · 结论变化' : ''}</div>}</div></article>)}</div></CardContent></Card>
      </div>
    </section>
    <section className="ledger-section">
      <Card>
        <CardHeader>
          <div>
            <h2>对账台账（按发生时间）</h2>
            <p className="muted">主事件时间线、处置动作与审批记录归并对账；补传事件以发生时间归位，补传时刻另记，不参与排序。</p>
          </div>
          <ShieldAlert color="#b91c1c" />
        </CardHeader>
        <CardContent>
          <table className="ledger-table">
            <thead><tr><th>发生时间</th><th>类型</th><th>来源/责任人</th><th>内容</th><th>补传时刻</th></tr></thead>
            <tbody>
              {ledger.map((entry) => (
                <tr key={entry.key} className={entry.kind === 'invalidation' ? 'row-invalid' : entry.backfilled ? 'row-backfilled' : ''}>
                  <td className="nowrap">{hm(entry.at)}</td>
                  <td><Badge className={`kind kind-${entry.kind}`}>{ledgerKindLabel[entry.kind]}</Badge></td>
                  <td className="nowrap">{entry.actor}</td>
                  <td>{entry.sensitive && !canSeeSensitive ? '敏感记录已隐藏' : entry.text}</td>
                  <td className="nowrap">{entry.backfilled ? hm(entry.receivedAt ?? '') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </section>
  </main>;
}
