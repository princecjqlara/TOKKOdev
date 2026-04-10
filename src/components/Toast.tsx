'use client';

import { ReactNode } from 'react';

interface ToastProps {
    type: 'success' | 'error' | 'info';
    message: string;
    onClose: () => void;
}

export default function Toast({ type, message, onClose }: ToastProps) {
    return (
        <div className={`toast toast-${type}`} onClick={onClose}>
            <span>{message}</span>
        </div>
    );
}

// Toast context for global usage
import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

interface ToastContextType {
    showToast: (type: 'success' | 'error' | 'info', message: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout>>();

    useEffect(() => {
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, []);

    const showToast = useCallback((type: 'success' | 'error' | 'info', message: string) => {
        if (timerRef.current) clearTimeout(timerRef.current);
        setToast({ type, message });
        timerRef.current = setTimeout(() => setToast(null), 5000);
    }, []);

    return (
        <ToastContext.Provider value={{ showToast }}>
            {children}
            {toast && (
                <Toast
                    type={toast.type}
                    message={toast.message}
                    onClose={() => setToast(null)}
                />
            )}
        </ToastContext.Provider>
    );
}

export function useToast() {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error('useToast must be used within a ToastProvider');
    }
    return context;
}
