import { invokeTauri, isTauriRuntime } from './tauri';

export async function createNativeWindow(search = ''): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error('native window creation requires the Tauri runtime');
  }

  await invokeTauri('create_native_window', { search });
}
