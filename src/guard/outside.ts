import type { PendingView } from "./admin";

/** The one line a notification can carry: the tool, the command cut short, and whose session it is. */
export function outsideText(request: PendingView, owner: string | undefined): string {
  const command = request.command.split("\n")[0] ?? "";
  const short = command.length > 90 ? `${command.slice(0, 89)}…` : command;
  const whose = owner !== undefined ? `сессия ${owner.split("-")[0] ?? owner}` : "сессия не определена";
  return `Защита ждёт решения (${whose}, её вкладка не открыта): ${request.tool} ${short}`;
}

/** What the person can press on the notification. Opening the session is the point; the rest keeps it honest. */
export const OPEN = "Открыть сессию";
export const DENY = "Запретить";

export type OutsideDeps = {
  /** A modal-free notification with buttons; resolves with the pressed button, or undefined when it was dismissed. */
  notify: (text: string, ...buttons: string[]) => Promise<string | undefined>;
  /** Opens the session's tab in THIS window (the only window we know the person is looking at). */
  openSession: (session: string) => Promise<void>;
  answer: (id: string, decision: "allow-once" | "deny") => Promise<void>;
  log: (text: string) => void;
};

/**
 * Requests nobody has a tab for, raised where the person will see them without any chat showing a card it was never
 * asked for. One notification per owning session at a time: a worker that asks ten times in a row would otherwise bury
 * the screen, and opening the session's tab brings up every card it has waiting anyway. A request with no owner at all
 * is not routed here — it goes to every tab with the honest wording, because there is no tab to open for it.
 *
 * The notification is not modal: it must not stop the person working in the window they are in, and only a toast can
 * carry buttons (the status bar cannot, and a 300 s deadline is too short to rely on something nobody looks at).
 * «Запретить» is on it because no is the commonest answer to a foreign request, and making the person open a whole chat
 * to say it is what produced the unanswered denials. The text names the command, so no is not a blind no.
 */
export class OutsideChats {
  /** Owning session -> the request its notification is up for. */
  private readonly showing = new Map<string, string>();

  constructor(private readonly deps: OutsideDeps) {}

  /** Returns the way to take the notification down when the request ends. */
  raise(request: PendingView, owner: string | undefined): () => void {
    const key = owner ?? request.session;
    if (this.showing.has(key)) return () => undefined; // one at a time per session: the tab shows the rest
    this.showing.set(key, request.id);
    let gone = false;
    const buttons = owner !== undefined ? [OPEN, DENY] : [DENY];
    void this.deps
      .notify(outsideText(request, owner), ...buttons)
      .then(async (pressed) => {
        if (this.showing.get(key) === request.id) this.showing.delete(key);
        if (gone || pressed === undefined) return; // dismissed, or the request ended: the deadline has it
        if (pressed === OPEN && owner !== undefined) return this.deps.openSession(owner);
        if (pressed === DENY) return this.deps.answer(request.id, "deny");
      })
      .catch((error: unknown) => this.deps.log(`Запрос защиты вне чатов: ${error instanceof Error ? error.message : String(error)}`));
    return () => {
      gone = true;
      if (this.showing.get(key) === request.id) this.showing.delete(key);
    };
  }
}
