import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_ROOT = path.join(__dirname, '../../uploads');

/** @param {string} avatarUrl stored value e.g. /uploads/avatars/foo.jpg */
export async function deleteLocalAvatarFile(avatarUrl) {
  if (!avatarUrl || typeof avatarUrl !== 'string') return;
  if (!avatarUrl.startsWith('/uploads/avatars/')) return;
  const rel = avatarUrl.replace(/^\/uploads\//, '');
  const full = path.join(UPLOADS_ROOT, rel);
  await fs.unlink(full).catch(() => {});
}
