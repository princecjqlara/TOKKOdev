export const MESSENGER_MEDIA_BUCKET = 'messenger-agent-media';
export const MAX_MESSENGER_MEDIA_BYTES = 10 * 1024 * 1024;
export const MAX_MESSENGER_MEDIA_FILES = 10;

export const MESSENGER_MEDIA_MIME_TYPES: Record<string, { type: 'image' | 'video' | 'audio' | 'file'; extension: string }> = {
    'image/jpeg': { type: 'image', extension: 'jpg' },
    'image/png': { type: 'image', extension: 'png' },
    'image/webp': { type: 'image', extension: 'webp' },
    'image/gif': { type: 'image', extension: 'gif' },
    'video/mp4': { type: 'video', extension: 'mp4' },
    'video/quicktime': { type: 'video', extension: 'mov' },
    'audio/mpeg': { type: 'audio', extension: 'mp3' },
    'audio/mp4': { type: 'audio', extension: 'm4a' },
    'audio/wav': { type: 'audio', extension: 'wav' },
    'audio/ogg': { type: 'audio', extension: 'ogg' },
    'application/pdf': { type: 'file', extension: 'pdf' },
    'application/msword': { type: 'file', extension: 'doc' },
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { type: 'file', extension: 'docx' },
    'application/vnd.ms-excel': { type: 'file', extension: 'xls' },
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { type: 'file', extension: 'xlsx' }
};
