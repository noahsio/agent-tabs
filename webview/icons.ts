/** Own line icons, drawn on a 24×24 grid with the current text colour; each one is centred on (12, 12). */
type Shape = ["path", string] | ["circle", number, number, number];

/** A box lid (x 3.5–20.5, y 4–8.5) and the box under it, shared by archive and unarchive. */
const BOX: Shape[] = [
  ["path", "M4.5 4h15a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"],
  ["path", "M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5"],
];

const SHAPES = {
  // A bookmark as tall as the clock (y 3.5–20.5), about 0.72 of that wide with the stroke; the notch as deep as in Claude Code's (~0.19 of the height).
  pin: [["path", "M6.1 3.5h11.8v17L12 16.9l-5.9 3.6z"]],
  sessions: [
    ["circle", 12, 12, 8.5],
    ["path", "M12 7.5V12l3 2"],
  ],
  // A round bubble centred on (12, 11) with its tail at the bottom left; the plus sits on the bubble's centre.
  newSession: [
    ["path", "M4.64 15.25A8.5 8.5 0 1 1 8.41 18.7L3.5 20.5z"],
    ["path", "M12 7.8v6.4M8.8 11h6.4"],
  ],
  spark: [["path", "M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"]],
  plus: [["path", "M12 5v14M5 12h14"]],
  search: [
    ["circle", 11, 11, 6.5],
    ["path", "m19.5 19.5-3.9-3.9"],
  ],
  slash: [
    ["path", "M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"],
    ["path", "m14 8-4 8"],
  ],
  pencil: [
    ["path", "M4.5 19.5 5.5 15 16 4.5a2.1 2.1 0 0 1 3 3L8.5 18z"],
    ["path", "m14 6.5 3.5 3.5"],
  ],
  // An open circle (r 7.5 about the centre) run counter-clockwise from its left point, its arrow head at that start.
  rewind: [
    ["path", "M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9"],
    ["path", "M4.5 4.5V9H9"],
  ],
  archive: [...BOX, ["path", "M10 12.5h4"]],
  unarchive: [...BOX, ["path", "M12 17v-5.5M9.5 14l2.5-2.5 2.5 2.5"]],
  check: [["path", "m5 12 5 5 9-10"]],
  // Two sheets — one behind (3.5–16), one in front (8–20.5) — so the pair is centred on (12, 12).
  copy: [
    ["path", "M9.5 8h9.5a1.5 1.5 0 0 1 1.5 1.5V19a1.5 1.5 0 0 1-1.5 1.5H9.5A1.5 1.5 0 0 1 8 19V9.5A1.5 1.5 0 0 1 9.5 8z"],
    ["path", "M16 8V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9.5A1.5 1.5 0 0 0 5 16h3"],
  ],
  chevron: [["path", "m9 6 6 6-6 6"]],
  // An upward arrow as tall as the clock (y 4.5–19.5), its head a third of that: the composer's «отправить».
  send: [
    ["path", "M12 19.5v-15"],
    ["path", "m6 10.5 6-6 6 6"],
  ],
  // A downward arrow onto a baseline: jump the feed down to the message the pinned copy mirrors.
  jumpTo: [
    ["path", "M12 4.5v9.5"],
    ["path", "m7 10 5 5 5-5"],
    ["path", "M5.5 19.5h13"],
  ],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof SHAPES;

const SVG = "http://www.w3.org/2000/svg";

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `icon icon-${name}`);
  for (const shape of SHAPES[name] as Shape[]) {
    const node = document.createElementNS(SVG, shape[0]);
    if (shape[0] === "path") node.setAttribute("d", shape[1]);
    else {
      node.setAttribute("cx", String(shape[1]));
      node.setAttribute("cy", String(shape[2]));
      node.setAttribute("r", String(shape[3]));
    }
    svg.append(node);
  }
  return svg;
}
