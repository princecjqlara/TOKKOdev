'use client';

import { useState } from 'react';
import { UTILITY_TEMPLATES } from '@/lib/facebook-templates';
import { submitMissingTemplatesToPages, type PageSubmissionResult, type SubmissionPage } from '@/lib/template-submission';

export default function SubmitMissingTemplates({ pages, disabled, onRunningChange, onComplete }: {
    pages: SubmissionPage[];
    disabled: boolean;
    onRunningChange: (running: boolean) => void;
    onComplete: () => Promise<void>;
}) {
    const [running, setRunning] = useState(false);
    const [results, setResults] = useState<PageSubmissionResult[]>([]);
    const [error, setError] = useState('');

    const submit = async () => {
        if (running || disabled || !pages.length) return;
        setRunning(true);
        onRunningChange(true);
        setResults([]);
        setError('');
        try {
            await submitMissingTemplatesToPages({
                pages,
                templateNames: UTILITY_TEMPLATES.map(template => template.name),
                onProgress: setResults
            });
            await onComplete();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setRunning(false);
            onRunningChange(false);
        }
    };

    const finishedPages = results.filter(result => result.state === 'complete' || result.state === 'failed').length;
    const submitted = results.reduce((sum, result) => sum + result.submitted, 0);

    return (
        <section className="mb-6 border border-black bg-white p-4" aria-label="Submit missing templates to all pages">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div>
                    <h2 className="font-bold">Missing templates across all pages</h2>
                    <p className="text-sm text-gray-600 mt-1">
                        Submit missing text templates to all {pages.length} connected pages. Existing templates are skipped. Facebook reviews each page separately.
                        {running && ' Keep this tab open until submission finishes.'}
                    </p>
                </div>
                <button onClick={submit} disabled={disabled || running || !pages.length}
                    className="btn-wireframe bg-black text-white hover:bg-gray-800 px-4 py-2 whitespace-nowrap">
                    {running ? `Submitting… ${finishedPages}/${pages.length} pages` : 'Submit Missing to All Pages'}
                </button>
            </div>
            {results.length > 0 && (
                <div className="mt-4" aria-live="polite" role="status">
                    <p className="text-sm font-bold mb-2">
                        {running ? 'In progress' : 'Submission finished'}: {submitted} submitted · {finishedPages}/{pages.length} pages checked
                    </p>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm text-left">
                            <thead><tr className="border-b border-gray-300">
                                {['Page', 'Status', 'Submitted', 'Already present', 'Failed', 'Remaining / unconfirmed'].map(label => (
                                    <th key={label} className="p-2">{label}</th>
                                ))}
                            </tr></thead>
                            <tbody>{results.map(result => (
                                <tr key={result.id} className="border-b border-gray-200 align-top">
                                    <td className="p-2">{result.name}</td>
                                    <td className="p-2">
                                        {result.state === 'failed' ? 'Needs retry' : result.state === 'complete' ? 'Done' : result.state === 'checking' ? 'Checking…' : 'Submitting…'}
                                        {result.error && <p className="text-xs text-red-700 mt-1 max-w-sm break-words">{result.error}</p>}
                                    </td>
                                    <td className="p-2">{result.submitted}</td>
                                    <td className="p-2">{result.alreadyExisted}</td>
                                    <td className="p-2">{result.failed}</td>
                                    <td className="p-2">{result.unattempted}</td>
                                </tr>
                            ))}</tbody>
                        </table>
                    </div>
                    {!running && results.some(result => result.state === 'failed') && (
                        <p className="text-sm mt-2">Fix any page connection errors, then use the button again. Templates already submitted will be skipped.</p>
                    )}
                </div>
            )}
            {error && <p role="alert" className="text-sm text-red-700 mt-3">{error}</p>}
        </section>
    );
}
