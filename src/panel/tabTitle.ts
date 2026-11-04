/** Longest editor-tab title, ellipsis included: a long session name must not stretch the tab across the tab bar. */
export const TAB_TITLE_MAX = 25;

/** Put before the title while the tab waits for the person (a question or an approval). */
export const WAITING_MARK = "● ";

/** The editor tab's title: whitespace collapsed, cut at a word-free boundary to TAB_TITLE_MAX with «…»; marked while `waiting`. */
export function tabTitle(name: string, waiting: boolean = false): string {
  const text = name.replace(/\s+/g, " ").trim();
  const title = text.length <= TAB_TITLE_MAX ? text : `${text.slice(0, TAB_TITLE_MAX - 1).trimEnd()}…`;
  return waiting ? `${WAITING_MARK}${title}` : title;
}
