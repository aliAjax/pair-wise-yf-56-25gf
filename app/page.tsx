'use client';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Eye, Radio, RefreshCw, ShieldAlert, UserCheck, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { buildLedger, receivedTimeline, useIncidentStore, type BackfillEventInput, type ResponseAction, type TimelineKind } from '@/lib/store';

const formSchema = z.object({ title: z.string().min(4, '请填写至少4个字的子事件'), owner: z.string().min(2, '请填写负责组') });
const roleNames = { analyst: '分析员', responder: '响应负责人', legal: '法务/公关', viewer: '访客' };
const kindLabels: Record<TimelineKind, string> = { alert: '告警', approval: '审批', execution: '执行', subincident: '子事件', system: '系统' };
const fmt = (at: string) => format(new Date(at), 'MM-dd HH:mm');

// 断网期间攒下的告警，回网后一次补传：
// - 发生时间（at）早于已完成的隔离审批，收到时刻（receivedAt）为补传当下
// - cred-login-geo 与已入账事件同幂等键，重复的不再记
// - offline-egress 模拟首次写入失败，仅这几条进失败队列待重试
// - offline-exfil 给出新结论（新增受影响资产 backup-server），导致原隔离审批失效
const offlineBatch: BackfillEventInput[] = [
  { dedupKey: 'offline-exfil', at: new Date(Date.now() - 45 * 60000).toISOString(), actor: '补传·告警平台', text: '【断网期间补传】备份服务器在断网时段被异常访问，疑似横向移动', newAffected: ['backup-server'] },
  { dedupKey: 'cred-login-geo', at: new Date(Date.now() - 40 * 60000).toISOString(), actor: '补传·告警平台', text: '【断网期间补传】检测到同一凭证跨三个地域登录' },
  { dedupKey: 'offline-cred-reuse', at: new Date(Date.now() - 30 * 60000).toISOString(), actor: '补传·告警平台', text: '【断网期间补传】涉事凭证在异地继续尝试登录' },
  { dedupKey: 'offline-egress', at: new Date(Date.now() - 20 * 60000).toISOString(), actor: '补传·告警平台', text: '【断网期间补传】建议封禁可疑出口地址', failOnce: true }
];

function SortableAction({ action }: { action: ResponseAction }) {
  const store = useIncidentStore();
  const sortable = useSortable({ id: action.id });
  const canSee = !action.sensitive || ['responder', 'legal'].includes(store.role);
  const targets = action.kind === 'isolate' ? (action.targets ?? []) : [];
  const isolatedCount = targets.filter((target) => target.status === 'isolated').length;
  const failedTargets = targets.filter((target) => target.status === 'failed');
  const isExecuted = action.status === 'executed';
  return (
    <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} className="action-row">
      <div>
        <strong>{canSee ? action.title : '敏感处置动作（当前角色不可见）'}</strong>
        <div className="muted">{action.kind} · 审批人 {action.approvals.join('、') || '无'} · {action.status}{action.kind === 'isolate' ? ` · 已隔离 ${isolatedCount}/${targets.length}` : ''}</div>
        {action.kind === 'isolate' && targets.length > 0 && (
          <div className="targets">
            {targets.map((target) => <span key={target.asset} className={`target-badge ${target.status}`}>{target.asset} · {target.status === 'isolated' ? '已隔离' : target.status === 'failed' ? '失败' : '待隔离'}</span>)}
          </div>
        )}
        {action.invalidated && <div className="invalidated">原审批已失效：{action.invalidatedReason}。请重新审批后执行。</div>}
        {failedTargets.length > 0 && (
          <div className="failed-box">
            <div className="failed-title">隔离失败项（{failedTargets.length} 项，重试跳过已隔离资产）</div>
            {failedTargets.map((target) => <div key={target.asset} className="failed-item"><span>{target.asset} · {target.error}</span><Button size="sm" variant="outline" disabled={store.demoMode || store.role === 'viewer'} onClick={() => store.executeAction(action.id)}><RefreshCw size={13} />重试失败项</Button></div>)}
          </div>
        )}
      </div>
      <div className="row-actions">
        <Button size="sm" variant="outline" disabled={store.demoMode || store.role === 'viewer' || action.approvals.includes(store.role)} onClick={() => store.approveAction(action.id)}><UserCheck size={14} />审批</Button>
        <Button size="sm" disabled={store.demoMode || store.role === 'viewer' || isExecuted} onClick={() => store.executeAction(action.id)}>{action.kind === 'isolate' && failedTargets.length > 0 ? '重试执行' : '执行'}</Button>
        <Button size="sm" variant="ghost" {...sortable.attributes} {...sortable.listeners}>排序</Button>
      </div>
    </div>
  );
}

export default function Page() {
  const t = useTranslations();
  const store = useIncidentStore();
  const incident = store.incident;
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof formSchema>>({ resolver: zodResolver(formSchema), defaultValues: { title: '', owner: '' } });
  const [view, setView] = useState<'received' | 'ledger'>('received');
  const { data: health = { connected: false, latency: 0 } } = useQuery({ queryKey: ['live'], queryFn: async () => ({ connected: true, latency: 42 }), refetchInterval: 10000 });
  useEffect(() => { const timer = window.setInterval(() => { if (!store.demoMode) store.tick(); }, 20000); return () => window.clearInterval(timer); }, [store.demoMode]);
  function dragEnd(event: DragEndEvent) { if (event.over) store.reorderActions(String(event.active.id), String(event.over.id)); }
  const canSeeSensitive = ['responder', 'legal'].includes(store.role);
  const timeline = receivedTimeline(incident);
  const ledger = buildLedger(incident);
  const failures = incident.backfillFailures;
  const last = incident.lastBackfill;

  return <main className="shell">
    <header className="topbar"><div><span className="eyebrow"><Radio size={14} /> LIVE WAR ROOM · PORT 62021</span><h1>{t('title')}</h1><p>{t('subtitle')}</p></div><div className="controls"><select value={store.role} onChange={(event) => store.setRole(event.target.value as typeof store.role)}>{Object.entries(roleNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><Button variant={store.demoMode ? 'danger' : 'outline'} onClick={store.toggleDemo}><Eye size={16} />{store.demoMode ? '退出演示' : t('demo')}</Button></div></header>
    {store.demoMode && <div className="demo-banner">只读演示模式已开启：审批、执行、拖拽和新增操作均被冻结，仍可查看允许范围内的内容。</div>}
    <section className="metrics"><Card><CardContent><span>当前事件</span><strong>{incident.id}</strong><Badge className="critical">{incident.severity}</Badge></CardContent></Card><Card><CardContent><span>实时通道</span><strong>{health.connected ? `${health.latency}ms` : '离线'}</strong><small>{health.connected ? '监测代理已连接' : '等待连接'}</small></CardContent></Card><Card><CardContent><span>子事件</span><strong>{incident.subIncidents.filter((item) => item.status !== 'closed').length}</strong><small>处理中</small></CardContent></Card><Card><CardContent><span>处置动作</span><strong>{incident.actions.filter((item) => item.status === 'executed').length}/{incident.actions.length}</strong><small>已执行/总数</small></CardContent></Card></section>
    <section className="grid">
      <div className="stack">
        <Card><CardHeader><div><h2>事件摘要</h2><p className="muted">影响范围：{incident.affected.join(' · ')}</p></div><ShieldAlert color={incident.severity === 'critical' ? '#ef4444' : '#f59e0b'} /></CardHeader><CardContent><div className="incident-state"><span>处置阶段</span><strong>{incident.status}</strong></div><h3>子事件</h3>{incident.subIncidents.map((item) => <div className="sub-row" key={item.id}><div><strong>{item.title}</strong><div className="muted">{item.owner}</div></div><Badge>{item.status}</Badge></div>)}</CardContent></Card>
        <Card><CardHeader><div><h2>{t('approval')}</h2><p className="muted">隔离动作需两名不同角色确认，敏感动作仅响应和法务角色可见；晚到补传改变结论时原审批失效退回待确认。</p></div><Users size={20} /></CardHeader><CardContent><DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}><SortableContext items={incident.actions.map((item) => item.id)} strategy={verticalListSortingStrategy}><div>{incident.actions.map((action) => <SortableAction key={action.id} action={action} />)}</div></SortableContext></DndContext></CardContent></Card>
      </div>
      <div className="stack">
        <Card><CardHeader><h2>新增子事件</h2></CardHeader><CardContent><form onSubmit={form.handleSubmit((values) => { store.addSubIncident(values); form.reset(); })}><label>子事件名称<Input {...form.register('title')} placeholder="例如：凭据轮换" /></label><small className="error">{form.formState.errors.title?.message}</small><label>负责组<Input {...form.register('owner')} placeholder="例如：平台组" /></label><small className="error">{form.formState.errors.owner?.message}</small><Button type="submit" disabled={store.demoMode}><ShieldAlert size={16} />创建子事件</Button></form></CardContent></Card>
        <Card className="timeline-card"><CardHeader><div><h2>{t('timeline')}</h2><p className="muted">按收到顺序排列；补传事件另记入账时刻，可按发生时间对账</p></div><div className="card-actions"><Button size="sm" variant="outline" disabled={store.demoMode} onClick={() => store.backfillEvents(offlineBatch)}>补传断网告警</Button>{failures.length > 0 && <Button size="sm" disabled={store.demoMode} onClick={() => store.retryBackfill()}><RefreshCw size={13} />重试补传（{failures.length}）</Button>}<Button size="sm" variant={view === 'ledger' ? 'default' : 'outline'} onClick={() => setView(view === 'received' ? 'ledger' : 'received')}>{view === 'received' ? '发生时间对账' : '返回收到顺序'}</Button></div></CardHeader><CardContent>
          {last && <div className="backfill-summary">最近补传：入账 {last.written} 条 · 重复跳过 {last.duplicated} 条 · 失败 {last.failed} 条</div>}
          {failures.length > 0 && <div className="failed-box"><div className="failed-title">补传失败项（{failures.length} 条，重试只补写未入账的几条）</div>{failures.map((failure) => <div key={failure.dedupKey} className="failed-item"><span>{failure.text}</span><span className="muted">{failure.error}</span></div>)}</div>}
          {view === 'received' ? <div className="timeline">{timeline.map((event) => <article key={event.id}><i /><div><div className="timeline-meta"><strong>{event.actor}{event.backfilled && <Badge className="backfill">补传</Badge>}</strong><span>{formatDistanceToNow(new Date(event.receivedAt), { addSuffix: true, locale: zhCN })}</span></div><p>{event.sensitive && !canSeeSensitive ? '敏感处置记录已隐藏' : event.text}</p><small className="muted">发生于 {fmt(event.at)} · 收到于 {fmt(event.receivedAt)}{event.backfilled ? '（断网补传）' : ''}</small></div></article>)}</div> : <div className="ledger"><div className="ledger-row ledger-head"><span>发生时间</span><span>入账时刻</span><span>类别</span><span>内容</span></div>{ledger.map((entry) => <div key={entry.id} className="ledger-row"><span className={entry.backfilled ? 'late' : ''}>{fmt(entry.at)}</span><span>{fmt(entry.recordedAt)}</span><span><Badge>{kindLabels[entry.kind]}</Badge></span><span>{entry.text}{entry.backfilled && <Badge className="backfill">补传</Badge>}</span></div>)}</div>}
        </CardContent></Card>
      </div>
    </section>
  </main>;
}
