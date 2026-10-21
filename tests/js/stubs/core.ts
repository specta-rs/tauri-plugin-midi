// Test stub for `@tauri-apps/api/core`.
//
// Routes through whatever `__TAURI_INTERNALS__` is present in the current
// context, so tests can supply a fake IPC layer.
export function invoke(command: string, args?: unknown, options?: unknown): Promise<unknown> {
  return (globalThis as any).__TAURI_INTERNALS__.invoke(command, args, options);
}
