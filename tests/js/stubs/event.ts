// Test stub for `@tauri-apps/api/event`.
//
// Mirrors the shape the real module exposes (`listen`/`once`/`emit` plus the
// `UnlistenFn`/`EventCallback`/`Event` types) but routes through the fake
// `__TAURI_INTERNALS__` installed by the test harness.
export type UnlistenFn = () => void;
export type Event<T> = { event: string; id: number; payload: T };
export type EventCallback<T> = (event: Event<T>) => void;

export async function listen<T>(
  event: string,
  handler: EventCallback<T>,
  options?: { target?: unknown }
): Promise<UnlistenFn> {
  const internals = (globalThis as any).__TAURI_INTERNALS__;
  const id = await internals.invoke("plugin:event|listen", {
    event,
    target: options?.target,
    handler: internals.transformCallback(handler),
  });
  return async () => {
    (globalThis as any).__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener?.(event, id);
    await internals.invoke("plugin:event|unlisten", { event, eventId: id });
  };
}

export async function once<T>(
  event: string,
  handler: EventCallback<T>,
  options?: { target?: unknown }
): Promise<UnlistenFn> {
  const unlisten = await listen<T>(
    event,
    (e) => {
      unlisten();
      handler(e);
    },
    options
  );
  return unlisten;
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  await (globalThis as any).__TAURI_INTERNALS__.invoke("plugin:event|emit", { event, payload });
}
