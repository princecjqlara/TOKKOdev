'use client';

import { useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';
import { Plus, Trash2, Edit2, Check, X, Tag as TagIcon, Search } from 'lucide-react';
import Pagination from '@/components/Pagination';
import Modal from '@/components/Modal';
import { Tag, Page, PaginatedResponse } from '@/types';

const TAG_COLORS = [
    '#000000', '#4b5563', '#dc2626', '#ea580c', '#d97706',
    '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777'
];

export default function TagsPage() {
    const { data: session } = useSession();
    const [pages, setPages] = useState<Page[]>([]);
    const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
    const [tags, setTags] = useState<Tag[]>([]);
    const [loading, setLoading] = useState(true);

    // Pagination
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(50);
    const [total, setTotal] = useState(0);

    // Selection
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    // Modals
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [showEditModal, setShowEditModal] = useState(false);
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [showBulkDeleteModal, setShowBulkDeleteModal] = useState(false);

    // Form state
    const [editingTag, setEditingTag] = useState<Tag | null>(null);
    const [tagName, setTagName] = useState('');
    const [tagColor, setTagColor] = useState(TAG_COLORS[0]);
    const [tagOwnerType, setTagOwnerType] = useState<'user' | 'page'>('page');
    const [actionLoading, setActionLoading] = useState(false);

    useEffect(() => {
        fetchPages();
    }, []);

    useEffect(() => {
        if (selectedPageId || session?.user?.id) {
            fetchTags();
        }
    }, [selectedPageId, page, pageSize, session]);

    const fetchPages = async () => {
        try {
            const res = await fetch('/api/pages');
            const data = await res.json();
            setPages(data.pages || []);
            if (data.pages?.length > 0) {
                setSelectedPageId(data.pages[0].id);
            }
        } catch (error) {
            console.error('Error fetching pages:', error);
        }
    };

    const fetchTags = async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({
                page: page.toString(),
                pageSize: pageSize.toString(),
                scope: 'all',
                ...(selectedPageId && { pageId: selectedPageId })
            });

            const res = await fetch(`/api/tags?${params}`);
            const data: PaginatedResponse<Tag> = await res.json();

            setTags(data.items || []);
            setTotal(data.total || 0);
        } catch (error) {
            console.error('Error fetching tags:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleSelectAll = () => {
        if (selectedIds.size === tags.length) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(tags.map(t => t.id)));
        }
    };

    const handleSelect = (id: string) => {
        const newSelected = new Set(selectedIds);
        if (newSelected.has(id)) {
            newSelected.delete(id);
        } else {
            newSelected.add(id);
        }
        setSelectedIds(newSelected);
    };

    const handleCreate = async () => {
        if (!tagName.trim()) return;

        setActionLoading(true);
        try {
            const ownerId = tagOwnerType === 'page' ? selectedPageId : session?.user?.id;

            await fetch('/api/tags', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: tagName.trim(),
                    color: tagColor,
                    ownerType: tagOwnerType,
                    ownerId,
                    pageId: selectedPageId
                })
            });

            setShowCreateModal(false);
            setTagName('');
            setTagColor(TAG_COLORS[0]);
            await fetchTags();
        } catch (error) {
            console.error('Error creating tag:', error);
        } finally {
            setActionLoading(false);
        }
    };

    const handleEdit = async () => {
        if (!editingTag || !tagName.trim()) return;

        setActionLoading(true);
        try {
            await fetch('/api/tags', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: editingTag.id,
                    name: tagName.trim(),
                    color: tagColor
                })
            });

            setShowEditModal(false);
            setEditingTag(null);
            setTagName('');
            await fetchTags();
        } catch (error) {
            console.error('Error updating tag:', error);
        } finally {
            setActionLoading(false);
        }
    };

    const handleDelete = async () => {
        if (!editingTag) return;

        setActionLoading(true);
        try {
            await fetch(`/api/tags?id=${editingTag.id}`, {
                method: 'DELETE'
            });

            setShowDeleteModal(false);
            setEditingTag(null);
            await fetchTags();
        } catch (error) {
            console.error('Error deleting tag:', error);
        } finally {
            setActionLoading(false);
        }
    };

    const handleBulkDelete = async () => {
        if (selectedIds.size === 0) return;

        setActionLoading(true);
        try {
            await fetch('/api/tags/bulk', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tagIds: Array.from(selectedIds)
                })
            });

            setShowBulkDeleteModal(false);
            setSelectedIds(new Set());
            await fetchTags();
        } catch (error) {
            console.error('Error bulk deleting tags:', error);
        } finally {
            setActionLoading(false);
        }
    };

    const openEditModal = (tag: Tag) => {
        setEditingTag(tag);
        setTagName(tag.name);
        setTagColor(tag.color);
        setShowEditModal(true);
    };

    const openDeleteModal = (tag: Tag) => {
        setEditingTag(tag);
        setShowDeleteModal(true);
    };

    const getOwnerTypeLabel = (tag: Tag) => {
        switch (tag.owner_type) {
            case 'user': return 'Personal';
            case 'page': return 'Page';
            case 'business': return 'Business';
            default: return tag.owner_type;
        }
    };

    return (
        <div className="p-6 md:p-8 max-w-[1400px] mx-auto fade-in">
            {/* Header */}
            <div className="flex flex-col md:flex-row items-center justify-between mb-8 gap-4">
                <div>
                    <h1 className="text-3xl font-black uppercase mb-2">Tag Manager</h1>
                    <p className="font-mono text-sm text-gray-500">
                        Create and organize tags for your contacts
                    </p>
                </div>

                <div className="flex items-center gap-3 w-full md:w-auto">
                    <div className="relative flex-1 md:w-64">
                        <select
                            value={selectedPageId || ''}
                            onChange={(e) => {
                                setSelectedPageId(e.target.value);
                                setPage(1);
                                setSelectedIds(new Set());
                            }}
                            className="input-wireframe w-full h-10"
                        >
                            {pages.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.name}
                                </option>
                            ))}
                        </select>
                    </div>

                    <button
                        onClick={() => {
                            setTagName('');
                            setTagColor(TAG_COLORS[0]);
                            setTagOwnerType('page');
                            setShowCreateModal(true);
                        }}
                        className="btn-wireframe whitespace-nowrap"
                    >
                        <Plus className="w-4 h-4 mr-2" />
                        Create Tag
                    </button>
                </div>
            </div>

            {/* Bulk Actions */}
            {selectedIds.size > 0 && (
                <div className="mb-6 p-4 border border-black bg-gray-50 flex items-center justify-between">
                    <span className="text-sm font-bold uppercase">
                        {selectedIds.size} Selected
                    </span>
                    <div className="flex gap-2">
                        <button
                            onClick={() => setShowBulkDeleteModal(true)}
                            className="btn-wireframe text-xs py-2 px-3 border-red-600 bg-red-50 hover:bg-red-600 hover:text-white"
                        >
                            <Trash2 className="w-3.5 h-3.5 mr-2" />
                            Delete
                        </button>
                        <button
                            onClick={() => setSelectedIds(new Set())}
                            className="btn-ghost-wireframe text-xs uppercase font-bold"
                        >
                            Clear
                        </button>
                    </div>
                </div>
            )}

            {/* Tags Grid */}
            {loading ? (
                <div className="flex items-center justify-center h-64 border border-black">
                    <div className="animate-spin w-8 h-8 border-2 border-black border-t-transparent rounded-full" />
                </div>
            ) : tags.length === 0 ? (
                <div className="wireframe-card text-center py-20">
                    <TagIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                    <h3 className="text-xl font-bold uppercase mb-2">No tags found</h3>
                    <p className="text-gray-500 font-mono text-sm mb-6">
                        Get started by creating your first tag.
                    </p>
                    <button
                        onClick={() => setShowCreateModal(true)}
                        className="btn-wireframe"
                    >
                        Create Tag
                    </button>
                </div>
            ) : (
                <>
                    <div className="overflow-x-auto border border-black">
                        <table className="table-wireframe">
                            <thead>
                                <tr>
                                    <th className="w-12">
                                        <input
                                            type="checkbox"
                                            checked={tags.length > 0 && selectedIds.size === tags.length}
                                            onChange={handleSelectAll}
                                            className="w-4 h-4 border border-black rounded-none focus:ring-0 text-black"
                                        />
                                    </th>
                                    <th>Tag Name</th>
                                    <th>Type</th>
                                    <th>Created Date</th>
                                    <th className="w-24 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="bg-white">
                                {tags.map((tag) => (
                                    <tr key={tag.id} className="hover:bg-gray-50 transition-colors">
                                        <td>
                                            <input
                                                type="checkbox"
                                                checked={selectedIds.has(tag.id)}
                                                onChange={() => handleSelect(tag.id)}
                                                className="w-4 h-4 border border-black rounded-none focus:ring-0 text-black"
                                            />
                                        </td>
                                        <td>
                                            <div className="flex items-center gap-3">
                                                <span
                                                    className="w-4 h-4 border border-black"
                                                    style={{ backgroundColor: tag.color }}
                                                ></span>
                                                <span className="font-bold">{tag.name}</span>
                                            </div>
                                        </td>
                                        <td>
                                            <span className={`badge-wireframe ${tag.owner_type === 'user' ? 'bg-gray-100' :
                                                    tag.owner_type === 'page' ? 'bg-black text-white' :
                                                        'bg-white'
                                                }`}>
                                                {getOwnerTypeLabel(tag)}
                                            </span>
                                        </td>
                                        <td className="font-mono text-xs text-gray-500">
                                            {new Date(tag.created_at).toLocaleDateString()}
                                        </td>
                                        <td>
                                            <div className="flex items-center justify-end gap-1">
                                                <button
                                                    onClick={() => openEditModal(tag)}
                                                    className="btn-ghost-wireframe"
                                                    title="Edit"
                                                >
                                                    <Edit2 className="w-4 h-4" />
                                                </button>
                                                <button
                                                    onClick={() => openDeleteModal(tag)}
                                                    className="btn-ghost-wireframe text-red-600 hover:bg-red-50 hover:text-red-700"
                                                    title="Delete"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <div className="mt-4 border border-black bg-white p-4">
                        <Pagination
                            page={page}
                            pageSize={pageSize}
                            total={total}
                            onPageChange={setPage}
                            onPageSizeChange={(size) => {
                                setPageSize(size);
                                setPage(1);
                            }}
                        />
                    </div>
                </>
            )}

            {/* Create Tag Modal */}
            <Modal
                isOpen={showCreateModal}
                onClose={() => setShowCreateModal(false)}
                title="Create New Tag"
            >
                <div className="space-y-6">
                    <div>
                        <label className="label-wireframe">Tag Name</label>
                        <input
                            type="text"
                            value={tagName}
                            onChange={(e) => setTagName(e.target.value)}
                            placeholder="ENTER TAG NAME"
                            className="input-wireframe"
                            autoFocus
                        />
                    </div>

                    <div>
                        <label className="label-wireframe">Color Label</label>
                        <div className="flex flex-wrap gap-2">
                            {TAG_COLORS.map((color) => (
                                <button
                                    key={color}
                                    onClick={() => setTagColor(color)}
                                    className={`w-8 h-8 border border-black transition-all ${tagColor === color ? 'bg-opacity-100 ring-2 ring-black ring-offset-2' : 'bg-opacity-80 hover:bg-opacity-100'
                                        }`}
                                    style={{ backgroundColor: color }}
                                />
                            ))}
                        </div>
                    </div>

                    <div>
                        <label className="label-wireframe">Scope</label>
                        <div className="grid grid-cols-2 gap-4">
                            <button
                                onClick={() => setTagOwnerType('page')}
                                className={`border border-black p-4 text-left transition-colors ${tagOwnerType === 'page' ? 'bg-black text-white' : 'bg-white hover:bg-gray-50'
                                    }`}
                            >
                                <p className="font-bold text-sm uppercase">Page Tag</p>
                                <p className={`text-xs mt-1 font-mono ${tagOwnerType === 'page' ? 'text-gray-300' : 'text-gray-500'}`}>
                                    Shared with team
                                </p>
                            </button>
                            <button
                                onClick={() => setTagOwnerType('user')}
                                className={`border border-black p-4 text-left transition-colors ${tagOwnerType === 'user' ? 'bg-black text-white' : 'bg-white hover:bg-gray-50'
                                    }`}
                            >
                                <p className="font-bold text-sm uppercase">Personal Tag</p>
                                <p className={`text-xs mt-1 font-mono ${tagOwnerType === 'user' ? 'text-gray-300' : 'text-gray-500'}`}>
                                    Private to you
                                </p>
                            </button>
                        </div>
                    </div>

                    <div className="flex justify-end gap-3 pt-4 border-t border-black">
                        <button
                            onClick={() => setShowCreateModal(false)}
                            className="btn-wireframe bg-white text-black hover:bg-gray-100"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleCreate}
                            disabled={!tagName.trim() || actionLoading}
                            className="btn-wireframe bg-black text-white hover:bg-gray-800"
                        >
                            {actionLoading ? 'Creating...' : 'Create Tag'}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* Edit Tag Modal */}
            <Modal
                isOpen={showEditModal}
                onClose={() => {
                    setShowEditModal(false);
                    setEditingTag(null);
                }}
                title="Edit Tag"
            >
                <div className="space-y-6">
                    <div>
                        <label className="label-wireframe">Tag Name</label>
                        <input
                            type="text"
                            value={tagName}
                            onChange={(e) => setTagName(e.target.value)}
                            className="input-wireframe"
                        />
                    </div>

                    <div>
                        <label className="label-wireframe">Color Label</label>
                        <div className="flex flex-wrap gap-2">
                            {TAG_COLORS.map((color) => (
                                <button
                                    key={color}
                                    onClick={() => setTagColor(color)}
                                    className={`w-8 h-8 border border-black transition-all ${tagColor === color ? 'bg-opacity-100 ring-2 ring-black ring-offset-2' : 'bg-opacity-80 hover:bg-opacity-100'
                                        }`}
                                    style={{ backgroundColor: color }}
                                />
                            ))}
                        </div>
                    </div>

                    <div className="flex justify-end gap-3 pt-4 border-t border-black">
                        <button
                            onClick={() => {
                                setShowEditModal(false);
                                setEditingTag(null);
                            }}
                            className="btn-wireframe bg-white text-black hover:bg-gray-100"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleEdit}
                            disabled={!tagName.trim() || actionLoading}
                            className="btn-wireframe bg-black text-white hover:bg-gray-800"
                        >
                            {actionLoading ? 'Saving...' : 'Save Changes'}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* Delete Tag Modal */}
            <Modal
                isOpen={showDeleteModal}
                onClose={() => {
                    setShowDeleteModal(false);
                    setEditingTag(null);
                }}
                title="Delete Tag"
            >
                <p className="text-gray-600 mb-6 font-mono text-sm">
                    Are you sure you want to delete <span className="font-bold text-black">&quot;{editingTag?.name}&quot;</span>?
                    This action cannot be undone.
                </p>
                <div className="flex justify-end gap-3 pt-4 border-t border-black">
                    <button
                        onClick={() => {
                            setShowDeleteModal(false);
                            setEditingTag(null);
                        }}
                        className="btn-wireframe bg-white text-black hover:bg-gray-100"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleDelete}
                        disabled={actionLoading}
                        className="btn-wireframe bg-red-600 text-white border-red-600 hover:bg-red-700"
                    >
                        {actionLoading ? 'Deleting...' : 'Delete Tag'}
                    </button>
                </div>
            </Modal>

            {/* Bulk Delete Modal */}
            <Modal
                isOpen={showBulkDeleteModal}
                onClose={() => setShowBulkDeleteModal(false)}
                title="Bulk Delete"
            >
                <p className="text-gray-600 mb-6 font-mono text-sm">
                    Are you sure you want to delete <span className="font-bold text-black">{selectedIds.size} tags</span>?
                    This action cannot be undone.
                </p>
                <div className="flex justify-end gap-3 pt-4 border-t border-black">
                    <button
                        onClick={() => setShowBulkDeleteModal(false)}
                        className="btn-wireframe bg-white text-black hover:bg-gray-100"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleBulkDelete}
                        disabled={actionLoading}
                        className="btn-wireframe bg-red-600 text-white border-red-600 hover:bg-red-700"
                    >
                        {actionLoading ? 'Deleting...' : 'Delete All'}
                    </button>
                </div>
            </Modal>
        </div>
    );
}
