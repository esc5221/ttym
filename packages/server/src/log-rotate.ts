import { copyFile, stat, truncate } from 'node:fs/promises';

/**
 * Copy-then-truncate rotation for ttym.log.
 *
 * The file only ever grew — production reached 130MB across a 41-day run —
 * because rotation by rename cannot work here: the server and every holder
 * hold their own append fd to it, opened once at spawn, and holders live for
 * weeks. After a rename they would all keep writing into the archived file.
 *
 * Copy-truncate sidesteps that. Every writer opens the log with 'a', and an
 * O_APPEND write positions itself at the current end on each call, so
 * truncating in place is safe: the same fds simply continue at the new EOF.
 * The window between copy and truncate can lose a line or two of holder
 * chatter, which is an acceptable price for not restarting holders.
 */
export const LOG_ROTATE_BYTES = 64 * 1024 * 1024;
export const LOG_ROTATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export async function rotateLogIfNeeded(
  logPath: string,
  maxBytes: number = LOG_ROTATE_BYTES,
): Promise<boolean> {
  let size: number;
  try {
    size = (await stat(logPath)).size;
  } catch {
    return false; // no log yet
  }
  if (size < maxBytes) return false;

  // One generation of history. The archive is overwritten each rotation —
  // anything worth keeping longer belongs somewhere deliberate, not in a
  // debug log's tail.
  await copyFile(logPath, `${logPath}.1`);
  await truncate(logPath, 0);
  return true;
}
