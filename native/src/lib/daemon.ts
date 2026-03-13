import { invokeTauri, isTauriRuntime } from './tauri';

export interface ServerBootstrap {
  port: number;
  running: boolean;
  binPath: string;
}

async function ping(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureLocalServer(port = 7690): Promise<ServerBootstrap> {
  if (await ping(port)) {
    return { port, running: true, binPath: 'already-running' };
  }

  if (!isTauriRuntime()) {
    throw new Error('ttym server is not running and native runtime is unavailable');
  }

  const info = await invokeTauri<ServerBootstrap>('ensure_local_server', { port });
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    if (await ping(info.port)) return info;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`ttym server did not become healthy on port ${info.port}`);
}
