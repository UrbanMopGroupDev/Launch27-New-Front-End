// Encrypted private storage for exported Kustomer records: each record is compressed and
// sealed with AES-256-GCM (random 12-byte IV, auth tag). The key comes from KUSTOMER_EXPORT_KEY,
// a Railway secret; the database alone can't be read without it.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const VERSION = 1;

export function createVault(secret) {
  if (!secret || String(secret).length < 32) throw new Error('KUSTOMER_EXPORT_KEY must be at least 32 characters');
  const key = createHash('sha256').update(`kustomer-export:${secret}`).digest();
  return {
    seal(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(value), 'utf8'))), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
    },
    open(buf) {
      const b = Buffer.from(buf);
      if (b[0] !== VERSION) throw new Error('Unknown vault format');
      const decipher = createDecipheriv('aes-256-gcm', key, b.subarray(1, 13));
      decipher.setAuthTag(b.subarray(13, 29));
      return JSON.parse(gunzipSync(Buffer.concat([decipher.update(b.subarray(29)), decipher.final()])).toString('utf8'));
    },
  };
}

export const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
