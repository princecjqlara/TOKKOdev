export const MESSAGE_TAGS = ['ACCOUNT_UPDATE', 'CONFIRMED_EVENT_UPDATE'] as const;
export type MessageTag = typeof MESSAGE_TAGS[number];
export const DEFAULT_MESSAGE_TAG: MessageTag = 'ACCOUNT_UPDATE';

export function isMessageTag(value: string | null | undefined): value is MessageTag {
  return typeof value === 'string' && MESSAGE_TAGS.includes(value as MessageTag);
}

export function normalizeMessageTag(value?: string | null): MessageTag {
  return isMessageTag(value) ? value : DEFAULT_MESSAGE_TAG;
}
