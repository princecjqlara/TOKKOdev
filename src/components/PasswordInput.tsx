'use client';
import { useId, useState, type InputHTMLAttributes } from 'react';

export default function PasswordInput({ className = '', disabled, id, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
    const generatedId = useId();
    const [visible, setVisible] = useState(false);
    const inputId = id || generatedId;
    return <div className="relative">
        <input {...props} id={inputId} disabled={disabled} type={visible ? 'text' : 'password'} className={`${className} pr-20`} />
        <button type="button" disabled={disabled} aria-controls={inputId} aria-pressed={visible}
            aria-label={visible ? 'Hide password' : 'Show password'}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold underline disabled:opacity-50"
            onClick={() => setVisible(previous => !previous)}>{visible ? 'Hide' : 'Show'}</button>
    </div>;
}
