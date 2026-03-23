import test from 'node:test';
import assert from 'node:assert/strict';
import { extractImageCdnMedia } from '../src/wechat/media.js';
import { MessageItemType, type MessageItem } from '../src/wechat/types.js';

test('extractImageCdnMedia supports current WeChat image_item.media payloads', () => {
  const item: MessageItem = {
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: 'abc123',
        aes_key: 'base64-key',
      },
      url: 'opaque-url',
      aeskey: 'legacy-hex-key',
    },
  };

  const media = extractImageCdnMedia(item);
  assert.deepEqual(media, {
    encrypt_query_param: 'abc123',
    aes_key: 'base64-key',
  });
});

test('extractImageCdnMedia still supports legacy cdn_media payloads', () => {
  const item: MessageItem = {
    type: MessageItemType.IMAGE,
    image_item: {
      cdn_media: {
        encrypt_query_param: 'legacy-query',
        aes_key: 'legacy-key',
      },
    },
  };

  const media = extractImageCdnMedia(item);
  assert.deepEqual(media, {
    encrypt_query_param: 'legacy-query',
    aes_key: 'legacy-key',
  });
});
