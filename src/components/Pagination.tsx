'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';

interface PaginationProps {
    page: number;
    pageSize: number;
    total: number;
    onPageChange: (page: number) => void;
    onPageSizeChange?: (pageSize: number) => void;
}

export default function Pagination({
    page,
    pageSize,
    total,
    onPageChange,
    onPageSizeChange
}: PaginationProps) {
    const totalPages = Math.ceil(total / pageSize);
    const from = (page - 1) * pageSize + 1;
    const to = Math.min(page * pageSize, total);

    const getVisiblePages = () => {
        const pages: (number | string)[] = [];
        const showEllipsis = totalPages > 7;

        if (!showEllipsis) {
            for (let i = 1; i <= totalPages; i++) {
                pages.push(i);
            }
        } else {
            if (page <= 4) {
                for (let i = 1; i <= 5; i++) pages.push(i);
                pages.push('...');
                pages.push(totalPages);
            } else if (page >= totalPages - 3) {
                pages.push(1);
                pages.push('...');
                for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i);
            } else {
                pages.push(1);
                pages.push('...');
                for (let i = page - 1; i <= page + 1; i++) pages.push(i);
                pages.push('...');
                pages.push(totalPages);
            }
        }

        return pages;
    };

    if (total === 0) return null;

    return (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 py-4">
            <div className="flex items-center gap-4">
                <span className="text-xs font-mono text-gray-500 uppercase">
                    Showing <span className="text-black font-bold">{from}</span> - <span className="text-black font-bold">{to}</span> of{' '}
                    <span className="text-black font-bold">{total}</span>
                </span>

                {onPageSizeChange && (
                    <select
                        value={pageSize}
                        onChange={(e) => onPageSizeChange(Number(e.target.value))}
                        className="h-8 border border-black bg-white text-xs font-bold px-2 focus:outline-none"
                    >
                        <option value={10}>10 / PAGE</option>
                        <option value={25}>25 / PAGE</option>
                        <option value={50}>50 / PAGE</option>
                        <option value={100}>100 / PAGE</option>
                    </select>
                )}
            </div>

            <div className="flex items-center gap-1">
                <button
                    onClick={() => onPageChange(page - 1)}
                    disabled={page === 1}
                    className="btn-ghost-wireframe h-8 w-8 p-0 border border-black disabled:opacity-30 disabled:cursor-not-allowed hover:bg-black hover:text-white"
                >
                    <ChevronLeft className="w-4 h-4" />
                </button>

                {getVisiblePages().map((p, i) =>
                    typeof p === 'number' ? (
                        <button
                            key={i}
                            onClick={() => onPageChange(p)}
                            className={`h-8 w-8 text-xs font-bold border border-black transition-all ${p === page
                                    ? 'bg-black text-white'
                                    : 'bg-white text-black hover:bg-gray-100'
                                }`}
                        >
                            {p}
                        </button>
                    ) : (
                        <span key={i} className="px-2 text-gray-500">
                            {p}
                        </span>
                    )
                )}

                <button
                    onClick={() => onPageChange(page + 1)}
                    disabled={page === totalPages}
                    className="btn-ghost-wireframe h-8 w-8 p-0 border border-black disabled:opacity-30 disabled:cursor-not-allowed hover:bg-black hover:text-white"
                >
                    <ChevronRight className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
}
