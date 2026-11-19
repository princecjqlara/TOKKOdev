import React from 'react';
import type { InquiryReport } from '@/lib/inquiry-insights';

const number = (n: number) => n.toLocaleString();
const rate = (n: number | null) => n === null ? 'Unavailable' : (n * 100).toLocaleString(undefined, { maximumFractionDigits: 1 }) + '%';
const minutes = (n: number | null) => n === null ? 'Unavailable' : n.toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' min';
function date(value: string | null) {
    return value ? new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }) : 'No events recorded yet';
}
export default function InquiryInsights({ report }: { report: InquiryReport }) {
    const e = report.episodes, r = report.response, f = report.funnel;
    return <div className="space-y-6">
        <div className="border-2 border-black p-4 text-sm space-y-2">
            <p>Tracking started {date(report.collection.started_at)} PHT. Only recorded inbound messages open inquiry episodes.</p>
            <p>A contact added after tracking starts has a New first episode when its inbound message is recorded. Older contact records and later episodes are Returning. A new episode starts after {report.collection.returning_after_days} days without a customer message. Episode dates use actual message times, not import dates.</p>
            <p>Dates use Philippine time. CRM stages and accepted messages do not verify payments or delivery.</p>
        </div>
        {!e.total && <section role="status" className="border-2 border-black p-6"><h2 className="font-bold">Waiting for new or returning inquiries</h2><p className="mt-2 text-sm">New inbound messages will appear here as they are recorded. Older contacts are not added as new inquiries. Try a wider date range if tracking has already received messages.</p></section>}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
                ['Inquiry episodes', number(e.total)], ['New contacts', number(e.new_contacts)], ['Returning inquiries', number(e.returning_contacts)], ['Distinct contacts', number(e.unique_contacts)],
                ['Observed replies', number(r.replied)], ['Median reply time', minutes(r.median_minutes)], ['P90 reply time', minutes(r.p90_minutes)], ['Response target met', rate(r.sla_rate)]
            ].map(([label, value]) => <section className="border-2 border-black p-4" key={label}><h2 className="text-sm font-bold">{label}</h2><p className="mt-2 text-2xl font-black">{value}</p></section>)}
        </div>
        <section className="border-2 border-black p-5 space-y-3"><h2 className="text-lg font-black">CRM funnel within {report.filters.horizon_hours} hours</h2>
            <p className="text-sm">{number(e.mature)} episodes have a complete observation window; {number(e.provisional)} are still provisional. {number(e.censored)} ended with an earlier returning inquiry. Rates use only complete windows. Missing intermediate stage events are not inferred.</p>
            <div className="grid gap-3 sm:grid-cols-3">{[['Qualified', f.qualified], ['Order created', f.order_created], ['CRM Converted', f.converted]].map(([label, value]) => <div className="border border-black p-3" key={label}><p className="text-sm font-bold">{label}</p><p className="text-xl font-black">{number(Number(value))}</p></div>)}</div>
            <p className="text-sm">Mature qualification rate: {rate(f.qualified_rate)} · Mature CRM conversion rate: {rate(f.converted_rate)}</p>
        </section>
        <section className="border-2 border-black p-5 space-y-2"><h2 className="text-lg font-black">Response coverage</h2>
            <p className="text-sm">Target: {report.collection.response_sla_minutes} minutes. {number(r.sla_met)} of {number(r.sla_eligible)} eligible episodes met it.</p>
            <p className="text-sm">Unanswered after the complete {report.filters.horizon_hours}-hour window: {number(r.mature_unanswered)} ({rate(r.unanswered_rate)}).</p>
            <p className="text-sm">Attributed human replies: {number(r.human_replied)} episodes. Attributed automation/welcome replies: {number(r.automated_replied)}. Page messages with an unknown sender source: {number(r.unknown_source_messages)}.</p>
            <p className="text-sm text-gray-600">Known bulk campaigns are excluded from reply-time measurements. Times use the first recorded qualifying Page message; accepted-send timestamps are not delivery confirmation. Unanswered episodes are shown separately from completed reply times.</p>
        </section>
        <section className="border-2 border-black p-5 space-y-2"><h2 className="text-lg font-black">Collection and data quality</h2>
            <p className="text-sm">Last tracked event: {date(report.collection.last_event_at)} PHT. Events may arrive live or through the existing Messenger history scans. Coverage is limited to the messages actually captured; a quiet Page alone does not prove collection failure.</p>
            <p className="text-sm"><a href="/dashboard/contacts" className="underline font-bold">Open Contacts</a> to refresh the Page’s existing Messenger data. Refreshing this report alone does not fetch new conversation history.</p>
            <p className="text-sm">Invalid or missing source IDs/times: {number(report.collection.invalid_events)}. Pre-tracking events ignored: {number(report.collection.historical_events_ignored)}.</p>
            <p className="text-sm">Existing contact records with a first-interaction time: {number(report.contact_coverage.first_interaction_known)} of {number(report.contact_coverage.total)} ({rate(report.contact_coverage.first_interaction_fraction)}). This legacy field is not used to invent historical inquiry episodes.</p>
        </section>
        <section className="border-2 border-black overflow-x-auto"><h2 className="text-lg font-black p-4">Latest inquiry episodes</h2><table className="w-full text-sm"><thead><tr className="border-y border-black text-left">{['Contact', 'Episode', 'Started · PHT', 'Inbound messages', 'First reply · PHT', 'Observed stage'].map(h => <th key={h} className="p-3">{h}</th>)}</tr></thead><tbody>{report.items.map(i => <tr key={i.episode_id} className="border-b border-gray-200"><td className="p-3">{i.name || 'Unnamed contact'}</td><td className="p-3">{i.kind === 'new_contact' ? 'New' : 'Returning'}</td><td className="p-3 whitespace-nowrap">{date(i.started_at)}</td><td className="p-3">{number(i.inbound_messages)}</td><td className="p-3 whitespace-nowrap">{i.first_reply_at ? date(i.first_reply_at) : 'Not recorded'}</td><td className="p-3">{i.stage.replaceAll('_', ' ')}</td></tr>)}</tbody></table><p className="p-4 text-sm text-gray-600">Up to 50 latest episodes. Totals include every eligible episode in the selected range. Updated {date(report.as_of)} PHT.</p></section>
    </div>;
}
