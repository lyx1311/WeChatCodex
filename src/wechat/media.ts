import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MessageItem } from './types.js';
import { MessageItemType, type CDNMedia } from './types.js';
import { downloadAndDecrypt } from './cdn.js';
import { logger } from '../logger.js';
import { TMP_DIR } from '../constants.js';

function detectMimeType(data: Buffer): string {
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png';
  if (data[0] === 0xFF && data[1] === 0xD8) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49) return 'image/gif';
  if (data[0] === 0x52 && data[1] === 0x49) return 'image/webp';
  if (data[0] === 0x42 && data[1] === 0x4D) return 'image/bmp';
  return 'image/jpeg'; // fallback
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/bmp':
      return '.bmp';
    default:
      return '.jpg';
  }
}

/**
 * Download a CDN image, decrypt it, and write it to a local temp file for
 * `codex --image`.
 */
export async function downloadImageToTemp(item: MessageItem): Promise<string | null> {
  const cdnMedia = extractImageCdnMedia(item);
  if (!cdnMedia) {
    return null;
  }

  try {
    const encryptQueryParam = cdnMedia.encrypt_query_param;
    const aesKeyBase64 = extractImageAesKeyBase64(item);
    if (!encryptQueryParam || !aesKeyBase64) {
      logger.warn('Image payload missing CDN download fields');
      return null;
    }

    const decrypted = await downloadAndDecrypt(encryptQueryParam, aesKeyBase64);
    const mimeType = detectMimeType(decrypted);
    mkdirSync(TMP_DIR, { recursive: true });
    const filePath = join(TMP_DIR, `${randomUUID()}${extensionForMimeType(mimeType)}`);
    writeFileSync(filePath, decrypted);
    logger.info('Image downloaded to temp file', { filePath, size: decrypted.length });
    return filePath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to download image', { error: msg });
    return null;
  }
}

export function cleanupTempFiles(filePaths: string[]): void {
  for (const filePath of filePaths) {
    try {
      unlinkSync(filePath);
    } catch {
      logger.warn('Failed to remove temp image', { filePath });
    }
  }
}

/**
 * Extract text content from a message item.
 * Returns text_item.text or empty string.
 */
export function extractText(item: MessageItem): string {
  return item.text_item?.text ?? '';
}

export function extractImageCdnMedia(item: MessageItem): CDNMedia | undefined {
  return item.image_item?.cdn_media ?? item.image_item?.media;
}

export function extractImageAesKeyBase64(item: MessageItem): string | undefined {
  const hexKey = item.image_item?.aeskey;
  if (hexKey) {
    return Buffer.from(hexKey, 'hex').toString('base64');
  }
  return extractImageCdnMedia(item)?.aes_key;
}

/**
 * Find the first IMAGE type item in a list.
 */
export function extractFirstImageUrl(items?: MessageItem[]): MessageItem | undefined {
  return items?.find((item) => item.type === MessageItemType.IMAGE);
}
