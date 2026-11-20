import type { ChatState } from "../chat/model";
import type { SessionController } from "../sessions/controller";

export type TabCloseDeps = {
  /** How long a closed tab waits before it touches its session: a window reload or quit ends the extension first. */
  delayMs: number;
  /** True once the extension is being shut down (deactivate): the session is let go, never closed. */
  shuttingDown: () => boolean;
  /** The person's answer to `question`: true for «Завершить». */
  ask: (question: string) => Promise<boolean>;
  log?: (text: string) => void;
};

/** What still works in a session, in words for the question; undefined when nothing does. */
export function stillWorking(state: Pick<ChatState, "running" | "background">): string | undefined {
  const count = state.background?.count ?? 0;
  const parts = [...(state.running ? ["ход агента"] : []), ...(count > 0 ? [`фоновых процессов: ${count}`] : [])];
  return parts.length === 0 ? undefined : parts.join(", ");
}

/**
 * What a closed tab does with its session. After `delayMs` it closes the session in OmO, so its turn, shells, monitors
 * and kernels end, unless the extension is shutting down meanwhile (a reload keeps every session, as before). While a
 * turn or background work still runs, the person is asked first; anything but «Завершить» only lets go of the session.
 */
export async function onTabClosed(controller: Pick<SessionController, "state" | "close" | "release">, title: string, deps: TabCloseDeps): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, deps.delayMs));
  if (deps.shuttingDown()) {
    await controller.release();
    return;
  }
  const working = stillWorking(controller.state);
  if (working !== undefined && !(await deps.ask(`Вкладка «${title}» закрыта, но в сессии ещё работают: ${working}. Завершить их?`))) {
    deps.log?.(`Сессия «${title}» оставлена работать: ${working}`);
    await controller.release();
    return;
  }
  const closed = await controller.close();
  deps.log?.(closed ? `Сессия «${title}» закрыта вместе с её процессами` : `Сессию «${title}» держит другой клиент: она продолжает работать`);
}
