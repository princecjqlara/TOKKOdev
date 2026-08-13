import { describe, expect, it } from 'vitest';
import {
    buildMediaTemplateVariant,
    getBaseTemplateName,
    getMediaTemplateName,
    getTemplateMediaTypeFromName,
    isMediaTemplateName,
    type TemplateDefinition
} from '../facebook-templates';

const baseTemplate: TemplateDefinition = {
    name: 'general_msg_v1',
    category: 'UTILITY',
    paramCount: 1,
    components: [{
        type: 'BODY',
        text: '{{1}}',
        example: { body_text: [['Example message']] }
    }]
};

describe('Facebook media templates', () => {
    it('adds an image header without invalid text content', () => {
        const result = buildMediaTemplateVariant(baseTemplate, 'uploaded-image-handle', 'image');

        expect(result.name).toBe('general_msg_v1_media_v1');
        expect(result.components[0]).toEqual({
            type: 'HEADER',
            format: 'IMAGE',
            example: { header_handle: ['uploaded-image-handle'] }
        });
        expect(result.components[1]).toEqual(baseTemplate.components[0]);
    });

    it('recognizes versioned media copies and preserves their exact names', () => {
        expect(isMediaTemplateName('general_msg_v1_media_v2')).toBe(true);
        expect(getBaseTemplateName('general_msg_v1_media_v2')).toBe('general_msg_v1');
        expect(getTemplateMediaTypeFromName('general_msg_v1_media_v2')).toBe('image');
        expect(getMediaTemplateName('general_msg_v1_media_v2', 'image')).toBe('general_msg_v1_media_v2');
        expect(getMediaTemplateName('general_msg_v1', 'image', 2)).toBe('general_msg_v1_media_v2');
    });
});
