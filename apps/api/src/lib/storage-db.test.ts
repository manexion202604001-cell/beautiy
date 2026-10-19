import { describe, expect, it } from 'vitest';
import { dbDriver, verifyLocalBlobToken } from './storage.js';

describe('database object storage (STORAGE_DRIVER=db)', () => {
  it('stores, overwrites, reads and deletes object bytes', async () => {
    const key = `org/00000000-0000-0000-0000-000000000000/staff_photo/test/${Math.random()}.jpg`;
    const a = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
    expect(await dbDriver.head(key)).toBeNull();
    await dbDriver.put(key, a, 'image/jpeg');
    expect(await dbDriver.head(key)).toEqual({ size: 6 });
    expect(Buffer.compare(await dbDriver.get(key), a)).toBe(0);
    const b = Buffer.from([0xff, 0xd8, 0xff, 9]);
    await dbDriver.put(key, b, 'image/jpeg');
    expect(Buffer.compare(await dbDriver.get(key), b)).toBe(0);
    await dbDriver.delete(key);
    expect(await dbDriver.head(key)).toBeNull();
    await expect(dbDriver.get(key)).rejects.toThrow();
  });

  it('hands out the same signed API URLs as local storage', async () => {
    const url = await dbDriver.presignDownload('org/x/menu_image/a.jpg', 60);
    const token = url.split('/v1/files/blob/')[1]!;
    expect(verifyLocalBlobToken(token)).toMatchObject({ k: 'org/x/menu_image/a.jpg', op: 'get' });
  });
});
