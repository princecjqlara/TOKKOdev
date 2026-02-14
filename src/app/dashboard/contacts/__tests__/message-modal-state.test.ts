import { describe, expect, it } from 'vitest';
import { DEFAULT_MESSAGE_TAG } from '../../../../lib/message-tags';
import { getMessageModalDefaults } from '../message-modal-state';

describe('message modal defaults', () => {
  it('resets the message tag to the default', () => {
    expect(getMessageModalDefaults().messageTag).toBe(DEFAULT_MESSAGE_TAG);
  });
});
