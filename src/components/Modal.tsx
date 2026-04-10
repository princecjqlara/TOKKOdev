'use client';

import { X } from 'lucide-react';
import { ReactNode, useEffect, useRef } from 'react';

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title?: string;
    children: ReactNode;
    size?: 'sm' | 'md' | 'lg' | 'xl';
}

export default function Modal({
    isOpen,
    onClose,
    title,
    children,
    size = 'md'
}: ModalProps) {
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCloseRef.current();
        };

        if (isOpen) {
            document.addEventListener('keydown', handleEscape);
            document.body.style.overflow = 'hidden';
        }

        return () => {
            document.removeEventListener('keydown', handleEscape);
            document.body.style.overflow = 'unset';
        };
    }, [isOpen]);

    if (!isOpen) return null;

    const sizeClasses = {
        sm: 'max-w-sm',
        md: 'max-w-md',
        lg: 'max-w-lg',
        xl: 'max-w-xl'
    };

    return (
        <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby={title ? 'modal-title' : undefined}>
            <div
                className={`modal ${sizeClasses[size]} animate-in zoom-in-95 duration-200`}
                onClick={(e) => e.stopPropagation()}
            >
                {title && (
                    <div className="flex items-center justify-between p-6 border-b-2 border-black bg-gray-50">
                        <h2 id="modal-title" className="text-xl font-black uppercase tracking-tight">{title}</h2>
                        <button
                            onClick={onClose}
                            aria-label="Close"
                            className="btn-ghost-wireframe p-1 hover:bg-gray-200 transition-colors border border-transparent hover:border-black"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                )}
                <div className="p-6">{children}</div>
            </div>
        </div>
    );
}
