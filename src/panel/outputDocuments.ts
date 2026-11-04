import * as vscode from "vscode";

export const OUTPUT_SCHEME = "agent-tabs-output";
const DEFAULT_KEEP = 20;

/**
 * Agent outputs as virtual documents of their own scheme: read-only, and closing one never asks to save.
 * Content is set by the caller (already redacted); only the most recent outputs are kept.
 */
export class OutputDocuments implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly keep: number = DEFAULT_KEEP) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  /** Opens (or refreshes) the output of one task; the tab is titled by its label. */
  async show(taskId: string, label: string, content: string): Promise<void> {
    const uri = vscode.Uri.from({ scheme: OUTPUT_SCHEME, path: `/${safeSegment(taskId)}/${safeSegment(label)}.log` });
    const key = uri.toString();
    this.contents.delete(key); // re-insert: the most recent goes last
    this.contents.set(key, content);
    for (const old of this.contents.keys()) {
      if (this.contents.size <= this.keep) break;
      this.contents.delete(old);
    }
    this.changed.fire(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** One path segment: no separators, never empty. */
function safeSegment(text: string): string {
  const clean = text.replace(/[/\\]/g, "-").trim();
  return clean === "" ? "agent" : clean;
}
