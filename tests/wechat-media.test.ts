import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCdnDownloadUrl } from '../src/wechat/cdn.js';
import { extractImageAesKeyBase64, extractImageCdnMedia } from '../src/wechat/media.js';
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

test('extractImageAesKeyBase64 prefers image_item.aeskey hex over media.aes_key', () => {
  const item: MessageItem = {
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: 'abc123',
        aes_key: 'stale-media-key',
      },
      aeskey: 'de801544bab4b1d79dd2bf384f65fd18',
    },
  };

  assert.equal(
    extractImageAesKeyBase64(item),
    '3oAVRLq0sded0r84T2X9GA==',
  );
});

test('buildCdnDownloadUrl targets the CDN download endpoint', () => {
  const url = buildCdnDownloadUrl('abc+/=xyz');
  assert.equal(
    url,
    'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=abc%2B%2F%3Dxyz',
  );
});
