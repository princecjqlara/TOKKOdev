const LOCAL_IMAGE_URL_PATTERN = /^data:image\//i;

export function isBrowserLocalImageUrl(value: string): boolean {
    return LOCAL_IMAGE_URL_PATTERN.test(value.trim());
}

export async function uploadImageHeader(file: Blob, pageId: string, fileName = 'photo-header'): Promise<string> {
    const formData = new FormData();
    formData.set('pageId', pageId);
    formData.set('file', file, fileName);

    const response = await fetch('/api/media/photo-header', {
        method: 'POST',
        body: formData
    });
    const data = await response.json().catch(() => ({} as Record<string, unknown>));

    if (!response.ok || typeof data.url !== 'string') {
        throw new Error(typeof data.message === 'string' ? data.message : 'Could not upload the photo header.');
    }

    return data.url;
}

export async function ensureSendableImageHeaderUrl(value: string, pageId: string): Promise<string> {
    const normalized = value.trim();
    if (!normalized) return '';
    if (!isBrowserLocalImageUrl(normalized)) return normalized;

    const response = await fetch(normalized);
    if (!response.ok) {
        throw new Error('Could not read the browser-local photo header. Please choose it again.');
    }

    const blob = await response.blob();
    return uploadImageHeader(blob, pageId, 'photo-header');
}
