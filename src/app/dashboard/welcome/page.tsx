'use client';

import { useSession } from 'next-auth/react';
import { useEffect, useState, useCallback } from 'react';
import {
    Hand,
    Save,
    Power,
    PowerOff,
    Link2,
    MessageSquare,
    X,
    Eye,
    AlertCircle
} from 'lucide-react';

interface WelcomeButton {
    type: 'URL' | 'QUICK_REPLY';
    text: string;
    url: string;
    payload: string;
}

interface WelcomeConfig {
    page_id: string;
    enabled: boolean;
    message_text: string;
    buttons: WelcomeButton[];
}

interface Page {
    id: string;
    fb_page_id: string;
    name: string;
}

export default function WelcomePage() {
    const { data: session } = useSession();
    const [pages, setPages] = useState<Page[]>([]);
    const [selectedPageId, setSelectedPageId] = useState<string>('');
    const [config, setConfig] = useState<WelcomeConfig | null>(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [showPreview, setShowPreview] = useState(false);

    // Editable fields
    const [enabled, setEnabled] = useState(false);
    const [messageText, setMessageText] = useState('');
    const [buttons, setButtons] = useState<WelcomeButton[]>([]);

    // Fetch pages
    useEffect(() => {
        if (session) {
            fetch('/api/pages')
                .then(r => r.json())
                .then(d => {
                    setPages(d.pages || []);
                    if (d.pages?.length > 0 && !selectedPageId) {
                        setSelectedPageId(d.pages[0].id);
                    }
                })
                .catch(console.error);
        }
    }, [session]);

    // Fetch welcome config when page changes
    const fetchConfig = useCallback(async () => {
        if (!selectedPageId) return;
        setLoading(true);
        try {
            const res = await fetch(`/api/pages/${selectedPageId}/welcome`);
            const data = await res.json();
            const cfg = data.config;
            setConfig(cfg);
            setEnabled(cfg.enabled);
            setMessageText(cfg.message_text || '');
            setButtons(cfg.buttons || []);
        } catch (err) {
            console.error('Failed to load welcome config:', err);
        } finally {
            setLoading(false);
        }
    }, [selectedPageId]);

    useEffect(() => {
        fetchConfig();
    }, [fetchConfig]);

    // Save config
    const handleSave = async () => {
        if (!selectedPageId) return;
        setSaving(true);
        setSaved(false);
        try {
            const res = await fetch(`/api/pages/${selectedPageId}/welcome`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    enabled,
                    message_text: messageText,
                    buttons: buttons.filter(b => b.text.trim())
                })
            });
            if (res.ok) {
                setSaved(true);
                setTimeout(() => setSaved(false), 3000);
            }
        } catch (err) {
            console.error('Failed to save:', err);
        } finally {
            setSaving(false);
        }
    };

    // Preview with sample personalization
    // Process double curly braces before single, and specific names before generic
    const previewText = messageText
        .replace(/\{\{first_name\}\}/gi, 'Juan')
        .replace(/\{\{firstname\}\}/gi, 'Juan')
        .replace(/\{\{last_name\}\}/gi, 'Dela Cruz')
        .replace(/\{\{lastname\}\}/gi, 'Dela Cruz')
        .replace(/\{\{name\}\}/gi, 'Juan Dela Cruz')
        .replace(/\{first_name\}/gi, 'Juan')
        .replace(/\{firstname\}/gi, 'Juan')
        .replace(/\{last_name\}/gi, 'Dela Cruz')
        .replace(/\{lastname\}/gi, 'Dela Cruz')
        .replace(/\{name\}/gi, 'Juan Dela Cruz');

    const selectedPageName = pages.find(p => p.id === selectedPageId)?.name || 'Page';

    return (
        <div className="max-w-3xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-white border-2 border-black flex items-center justify-center">
                        <Hand className="w-5 h-5" />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-black">Welcome Message</h1>
                        <p className="text-xs text-gray-500 font-mono">Auto-greet new contacts when they first message your page</p>
                    </div>
                </div>
                <button
                    onClick={handleSave}
                    disabled={saving || !selectedPageId}
                    className="btn-wireframe bg-black text-white hover:bg-gray-800 flex items-center gap-2 px-4 py-2.5"
                >
                    <Save className="w-4 h-4" />
                    {saving ? 'Saving...' : saved ? '✓ Saved!' : 'Save'}
                </button>
            </div>

            {/* Page Selector */}
            <div className="border-2 border-black p-4 mb-4 bg-white">
                <label className="font-mono text-xs font-bold uppercase text-gray-500 mb-2 block">Select Page</label>
                <select
                    value={selectedPageId}
                    onChange={(e) => setSelectedPageId(e.target.value)}
                    className="input-wireframe w-full text-sm"
                >
                    {pages.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                </select>
            </div>

            {loading ? (
                <div className="border-2 border-black p-8 text-center">
                    <div className="spinner w-6 h-6 mx-auto mb-2"></div>
                    <p className="text-sm text-gray-500 font-mono">Loading config...</p>
                </div>
            ) : (
                <>
                    {/* Enable/Disable Toggle */}
                    <div className="border-2 border-black p-4 mb-4 bg-white">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                {enabled ? (
                                    <Power className="w-5 h-5 text-green-600" />
                                ) : (
                                    <PowerOff className="w-5 h-5 text-gray-400" />
                                )}
                                <div>
                                    <p className="font-bold text-sm">
                                        {enabled ? 'Welcome Message Active' : 'Welcome Message Disabled'}
                                    </p>
                                    <p className="text-xs text-gray-500 font-mono">
                                        {enabled
                                            ? `New contacts on "${selectedPageName}" will receive this message`
                                            : 'Enable to auto-greet new contacts'}
                                    </p>
                                </div>
                            </div>
                            <button
                                onClick={() => setEnabled(!enabled)}
                                className={`relative w-12 h-6 rounded-full transition-colors ${enabled ? 'bg-green-500' : 'bg-gray-300'
                                    }`}
                            >
                                <span
                                    className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${enabled ? 'translate-x-6' : 'translate-x-0.5'
                                        }`}
                                />
                            </button>
                        </div>
                    </div>

                    {/* Message Text */}
                    <div className="border-2 border-black p-4 mb-4 bg-white">
                        <label className="font-mono text-xs font-bold uppercase text-gray-500 mb-2 block">
                            Message Text
                        </label>
                        <textarea
                            value={messageText}
                            onChange={(e) => setMessageText(e.target.value)}
                            placeholder="Hi {first_name}! 👋 Welcome to our page! How can we help you today?"
                            rows={4}
                            className="input-wireframe w-full text-sm resize-none"
                        />
                        <div className="mt-3 bg-gray-50 border border-gray-200 p-3 rounded">
                            <p className="font-bold text-gray-700 mb-1 text-xs">💡 Personalize your message:</p>
                            <div className="flex flex-wrap gap-2 font-mono">
                                <button
                                    type="button"
                                    onClick={() => setMessageText(prev => prev + '{{name}}')}
                                    className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-xs hover:bg-blue-200 cursor-pointer"
                                >
                                    {'{{name}}'}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setMessageText(prev => prev + '{{first_name}}')}
                                    className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-xs hover:bg-blue-200 cursor-pointer"
                                >
                                    {'{{first_name}}'}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setMessageText(prev => prev + '{{last_name}}')}
                                    className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-xs hover:bg-blue-200 cursor-pointer"
                                >
                                    {'{{last_name}}'}
                                </button>
                            </div>
                            <p className="text-gray-500 mt-1 text-[10px]">Click to insert. These get replaced with each contact&apos;s actual name.</p>
                        </div>
                    </div>

                    {/* Buttons Section */}
                    <div className="border-2 border-black p-4 mb-4 bg-white">
                        <div className="flex items-center justify-between mb-3">
                            <label className="font-mono text-xs font-bold uppercase text-gray-500 flex items-center gap-1.5">
                                <Link2 className="w-3.5 h-3.5" />
                                Buttons
                            </label>
                            {buttons.length < 3 && (
                                <div className="flex gap-1">
                                    <button
                                        type="button"
                                        onClick={() => setButtons([...buttons, { type: 'URL', text: '', url: '', payload: '' }])}
                                        className="btn-ghost-wireframe text-[10px] uppercase font-bold px-2 py-1 flex items-center gap-1"
                                    >
                                        <Link2 className="w-3 h-3" />
                                        + Link
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setButtons([...buttons, { type: 'QUICK_REPLY', text: '', url: '', payload: '' }])}
                                        className="btn-ghost-wireframe text-[10px] uppercase font-bold px-2 py-1 flex items-center gap-1"
                                    >
                                        <MessageSquare className="w-3 h-3" />
                                        + Quick Reply
                                    </button>
                                </div>
                            )}
                        </div>
                        {buttons.length === 0 && (
                            <p className="text-xs text-gray-400 font-mono">No buttons. Add up to 3 link or quick reply buttons.</p>
                        )}
                        <div className="space-y-2">
                            {buttons.map((btn, idx) => (
                                <div key={idx} className="flex items-start gap-2 p-2 border border-gray-200 bg-gray-50">
                                    <div className="flex-1 space-y-1">
                                        <div className="flex items-center gap-2">
                                            <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${btn.type === 'URL'
                                                ? 'bg-blue-100 text-blue-700'
                                                : 'bg-green-100 text-green-700'
                                                }`}>
                                                {btn.type === 'URL' ? '🔗 Link' : '💬 Reply'}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    const updated = [...buttons];
                                                    updated[idx] = {
                                                        ...updated[idx],
                                                        type: btn.type === 'URL' ? 'QUICK_REPLY' : 'URL',
                                                        url: '',
                                                        payload: ''
                                                    };
                                                    setButtons(updated);
                                                }}
                                                className="text-[10px] text-gray-400 hover:text-black underline cursor-pointer"
                                            >
                                                Switch to {btn.type === 'URL' ? 'Quick Reply' : 'Link'}
                                            </button>
                                        </div>
                                        <input
                                            type="text"
                                            value={btn.text}
                                            onChange={(e) => {
                                                const updated = [...buttons];
                                                updated[idx] = { ...updated[idx], text: e.target.value };
                                                setButtons(updated);
                                            }}
                                            placeholder="Button text (e.g. View Details)"
                                            className="input-wireframe w-full text-xs h-8"
                                        />
                                        {btn.type === 'URL' ? (
                                            <input
                                                type="url"
                                                value={btn.url}
                                                onChange={(e) => {
                                                    const updated = [...buttons];
                                                    updated[idx] = { ...updated[idx], url: e.target.value };
                                                    setButtons(updated);
                                                }}
                                                placeholder="https://example.com"
                                                className="input-wireframe w-full text-xs h-8"
                                            />
                                        ) : (
                                            <input
                                                type="text"
                                                value={btn.payload}
                                                onChange={(e) => {
                                                    const updated = [...buttons];
                                                    updated[idx] = { ...updated[idx], payload: e.target.value };
                                                    setButtons(updated);
                                                }}
                                                placeholder="Message contact will send (e.g. I'm interested!)"
                                                className="input-wireframe w-full text-xs h-8"
                                            />
                                        )}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setButtons(buttons.filter((_, i) => i !== idx))}
                                        className="btn-ghost-wireframe p-1 text-red-500 hover:bg-red-50 mt-1"
                                    >
                                        <X className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Preview */}
                    <div className="border-2 border-black p-4 mb-4 bg-white">
                        <button
                            onClick={() => setShowPreview(!showPreview)}
                            className="flex items-center gap-2 font-mono text-xs font-bold uppercase text-gray-500 mb-2"
                        >
                            <Eye className="w-3.5 h-3.5" />
                            {showPreview ? 'Hide Preview' : 'Show Preview'}
                        </button>
                        {showPreview && (
                            <div className="bg-[#f0f0f0] border border-gray-300 rounded-lg p-4">
                                <p className="text-[10px] font-mono text-gray-400 mb-2 uppercase">Preview (as &quot;Juan Dela Cruz&quot; would see it)</p>
                                {/* Message bubble */}
                                <div className="bg-white border border-gray-200 rounded-lg p-3 max-w-xs shadow-sm">
                                    <p className="text-sm whitespace-pre-wrap">{previewText || <span className="text-gray-400 italic">No message text</span>}</p>
                                </div>
                                {/* Button previews */}
                                {buttons.filter(b => b.text.trim()).length > 0 && (
                                    <div className="mt-2 space-y-1 max-w-xs">
                                        {buttons.filter(b => b.text.trim()).map((btn, idx) => (
                                            <div
                                                key={idx}
                                                className={`text-center py-2 px-3 rounded border text-xs font-medium ${btn.type === 'URL'
                                                    ? 'bg-blue-50 border-blue-200 text-blue-700'
                                                    : 'bg-green-50 border-green-200 text-green-700'
                                                    }`}
                                            >
                                                {btn.type === 'URL' ? '🔗 ' : '💬 '}
                                                {btn.text}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Info */}
                    <div className="bg-yellow-50 border-2 border-yellow-300 p-3 mb-4 flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 text-yellow-600 mt-0.5 flex-shrink-0" />
                        <div className="text-xs text-yellow-800 font-mono">
                            <p className="font-bold mb-1">How it works:</p>
                            <ul className="list-disc pl-4 space-y-0.5">
                                <li>Welcome message is sent only to <strong>brand new contacts</strong> when they first message your page</li>
                                <li>Uses <strong>HUMAN_AGENT</strong> messaging type (works within 24-hour window)</li>
                                <li>Each page has its own independent welcome message config</li>
                                <li>The message is sent automatically — no manual action needed</li>
                            </ul>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
