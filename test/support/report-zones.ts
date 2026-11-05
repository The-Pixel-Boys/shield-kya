/**
 * Split a rendered report page into its parts by the zone markers. The report shows one zone at a
 * time, so markup in `top` (between <main> and the first zone) repeats on every page.
 */
export function reportZones(html: string): { top: string; zones: Record<string, string> } {
  const main = html.indexOf("<main");
  const end = html.indexOf("</main>");
  if (main < 0 || end < 0) throw new Error("no <main> in the page");
  const body = html.slice(main, end);
  const re = /<section class="zone" id="([a-z-]+)"/g;
  const starts: { id: string; at: number }[] = [];
  for (let m = re.exec(body); m; m = re.exec(body)) starts.push({ id: m[1]!, at: m.index });
  if (starts.length === 0) throw new Error("no zones in the page");
  const zones: Record<string, string> = {};
  starts.forEach((s, i) => {
    zones[s.id] = body.slice(s.at, i + 1 < starts.length ? starts[i + 1]!.at : body.length);
  });
  return { top: body.slice(0, starts[0]!.at), zones };
}

export const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
