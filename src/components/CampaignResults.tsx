import type { Campaign } from '@/types';
import { FAILURE_INFO, FAILURE_KINDS, getDeliveryMetrics, readDeliveryDiagnostic } from '@/lib/delivery-diagnostics';

type ResultsCampaign = Pick<Campaign, 'total_recipients' | 'sent_count' | 'failed_count'> & Partial<Campaign>;
const format = (value: number) => value.toLocaleString();
const percent = (value: number) => `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;

export default function CampaignResults({ campaign, title = 'Bulk send results' }: { campaign: ResultsCampaign; title?: string }) {
    const metrics = getDeliveryMetrics(campaign);
    const manuallyStopped = /^Stopped manually\./i.test(campaign.last_error || '');
    const interruption = campaign.last_error && !manuallyStopped ? readDeliveryDiagnostic(campaign.last_error_diagnostic, campaign.last_error) : null;
    const info = interruption ? FAILURE_INFO[interruption.kind] : null;
    return (
        <section aria-label={title} className="border border-gray-300 bg-white p-4 space-y-4 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-bold uppercase tracking-wide">{title}</h4>
                <span className="font-mono text-xs text-gray-600">{format(metrics.total)} {campaign.is_loop ? 'attempts across all cycles' : 'recipients'}</span>
            </div>
            <div role="img" aria-label={`Sent ${format(metrics.sent)} (${percent(metrics.sentPercent)}), failed ${format(metrics.failed)} (${percent(metrics.failedPercent)}), not sent ${format(metrics.pending)} (${percent(metrics.pendingPercent)})`}
                className="flex h-5 w-full overflow-hidden rounded-sm bg-gray-200">
                <div className="bg-emerald-600" style={{ width: `${metrics.sentPercent}%` }} />
                <div className="bg-red-500" style={{ width: `${metrics.failedPercent}%` }} />
            </div>
            <div className={`grid ${campaign.is_loop ? 'grid-cols-2' : 'grid-cols-3'} gap-3`}>
                {[
                    { label: 'Sent', count: metrics.sent, rate: metrics.sentPercent, color: 'text-emerald-700', dot: 'bg-emerald-600' },
                    { label: 'Failed', count: metrics.failed, rate: metrics.failedPercent, color: 'text-red-700', dot: 'bg-red-500' },
                    ...(!campaign.is_loop ? [{ label: campaign.status === 'cancelled' ? 'Not sent' : 'Queued / not sent', count: metrics.pending, rate: metrics.pendingPercent, color: 'text-gray-700', dot: 'bg-gray-300' }] : [])
                ].map(item => <div key={item.label}>
                    <p className={`text-xs font-bold ${item.color}`}><span aria-hidden="true" className={`inline-block w-2 h-2 mr-1 ${item.dot}`} />{item.label}</p>
                    <p className={`text-xl sm:text-2xl font-black break-words ${item.color}`}>{format(item.count)}</p>
                    <p className="font-mono text-xs text-gray-600">{percent(item.rate)}</p>
                </div>)}
            </div>
            <p className="text-xs text-gray-500">Sent means Meta accepted the {campaign.is_loop ? 'send attempt' : 'recipient’s message sequence'}; delivery and read status are not confirmed. Percentages use {campaign.is_loop ? 'all recorded attempts' : 'the recipient total'}.</p>
            {metrics.failed > 0 && <details className="border-t border-gray-200 pt-3" open>
                <summary className="text-xs font-bold cursor-pointer">Why messages failed</summary>
                <div className="mt-3 space-y-3">
                    {FAILURE_KINDS.filter(kind => metrics.counts[kind] > 0).map(kind => (
                        <div key={kind}>
                            <div className="flex flex-wrap justify-between gap-2 text-xs">
                                <span className="font-bold">{FAILURE_INFO[kind].label}</span>
                                <span className="font-mono">{format(metrics.counts[kind])} · {percent(metrics.counts[kind] / metrics.failed * 100)} of failures</span>
                            </div>
                            <p className="mt-1 text-xs text-gray-600">{FAILURE_INFO[kind].explanation}</p>
                        </div>
                    ))}
                </div>
            </details>}
            {info && <div className="border-l-2 border-amber-500 bg-amber-50 p-3 space-y-1" role="status">
                <p className="text-xs font-bold">Latest delivery interruption: {info.label}</p>
                <p className="text-xs">{info.explanation} {info.action}</p>
                <p className="text-xs break-words">{campaign.last_error}</p>
                <p className="text-xs">This interruption is separate from the failed-recipient total. Remaining recipients stay unsent until delivery resumes.</p>
                {campaign.next_attempt_at && <p className="text-xs">Next retry: {new Date(campaign.next_attempt_at).toLocaleString()}</p>}
            </div>}
            {manuallyStopped && <p className="text-xs text-amber-800" role="status">Paused manually. Unsent recipients are saved; use Continue Unsent on the campaign to resume.</p>}
        </section>
    );
}
