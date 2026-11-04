import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { OUTPUT_SCHEME, OutputDocuments } from "../../src/panel/outputDocuments";

vi.mock("vscode", () => {
  class EventEmitter<T> {
    private readonly listeners: ((value: T) => void)[] = [];
    readonly event = (listener: (value: T) => void): { dispose(): void } => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };
    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {}
  }
  const uri = (parts: { scheme: string; path: string }) => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}` });
  return {
    EventEmitter,
    Uri: { from: uri },
    workspace: { openTextDocument: vi.fn(async (target: unknown) => ({ uri: target })) },
    window: { showTextDocument: vi.fn(async () => undefined) },
  };
});

describe("OutputDocuments", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens_a_read_only_document_of_its_own_scheme_with_the_content", async () => {
    const documents = new OutputDocuments();
    await documents.show("t-1", "Поиск/файлов", "log text");
    const uri = vi.mocked(vscode.workspace.openTextDocument).mock.calls[0]?.[0] as unknown as vscode.Uri;
    expect(uri.scheme).toBe(OUTPUT_SCHEME); // not an untitled file: closing it never asks to save
    expect(uri.path).toBe("/t-1/Поиск-файлов.log");
    expect(documents.provideTextDocumentContent(uri)).toBe("log text");
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith({ uri }, { preview: true });
  });

  it("showing_the_same_task_again_refreshes_the_open_document", async () => {
    const documents = new OutputDocuments();
    const changed: string[] = [];
    documents.onDidChange((uri) => changed.push(uri.toString()));
    await documents.show("t-1", "a", "first");
    await documents.show("t-1", "a", "second");
    const uri = vi.mocked(vscode.workspace.openTextDocument).mock.calls[1]?.[0] as unknown as vscode.Uri;
    expect(documents.provideTextDocumentContent(uri)).toBe("second");
    expect(changed).toEqual([`${OUTPUT_SCHEME}:/t-1/a.log`, `${OUTPUT_SCHEME}:/t-1/a.log`]);
  });

  it("keeps_only_the_most_recent_outputs", async () => {
    const documents = new OutputDocuments(2);
    for (const id of ["1", "2", "3"]) await documents.show(id, "x", `out ${id}`);
    const uris = vi.mocked(vscode.workspace.openTextDocument).mock.calls.map((call) => call[0] as unknown as vscode.Uri);
    expect(uris.map((uri) => documents.provideTextDocumentContent(uri))).toEqual(["", "out 2", "out 3"]);
  });
});
