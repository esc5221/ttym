import { pathToFileURL } from 'node:url';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from './server.js';
import { getHomeDir } from './session.js';

const PORT = parseInt(process.env.PORT || '7690', 10);

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  const homeDir = getHomeDir();
  mkdirSync(homeDir, { recursive: true });
  const pidFile = resolve(homeDir, 'ttym.pid');

  createServer(PORT).then((server) => {
    writeFileSync(pidFile, String(process.pid));
    console.log(`ttym server listening on port ${PORT} (pid ${process.pid})`);

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try { unlinkSync(pidFile); } catch {}

      // Persist all sessions before closing (workspace restore on reboot)
      const deadline = setTimeout(() => {
        console.error('[shutdown] persist deadline exceeded, force exit');
        process.exit(1);
      }, 5000);

      try {
        await server.close();
      } catch (e) {
        console.error('[shutdown] error:', e);
      }

      clearTimeout(deadline);
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

export { createServer } from './server.js';
