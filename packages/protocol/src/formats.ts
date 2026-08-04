/**
 * IAB creative formats.
 *
 * Carried over unchanged from DATUM (`sdk/datum-sdk.js` SLOT_SIZES and the
 * WordPress plugin's format list) because publishers already have markup
 * pinned to these names and the sizes are an industry standard, not ours.
 *
 * Two things depend on this table agreeing everywhere, which is why it lives
 * in @broadside/protocol rather than in the widget:
 *
 *   - The widget sizes the slot element from it before any creative loads, so
 *     the page does not reflow when one arrives.
 *   - Advertisers target a format by adding its `tag` to a campaign's required
 *     tags, and the widget injects that same tag into the per-slot auction.
 *     If the two spellings drift, format targeting silently matches nothing.
 */

export interface CreativeFormat {
  /** Stable slug used in `data-bs-slot` and in the format tag. */
  readonly id: string;
  /** Human label for consoles and the block editor. */
  readonly label: string;
  readonly width: number;
  readonly height: number;
  /** The targeting tag advertisers put in a campaign's required tags. */
  readonly tag: `format:${string}`;
}

function fmt(id: string, label: string, width: number, height: number): CreativeFormat {
  return { id, label, width, height, tag: `format:${id}` };
}

export const CREATIVE_FORMATS: readonly CreativeFormat[] = [
  fmt("leaderboard", "Leaderboard", 728, 90),
  fmt("medium-rectangle", "Medium Rectangle", 300, 250),
  fmt("wide-skyscraper", "Wide Skyscraper", 160, 600),
  fmt("half-page", "Half Page", 300, 600),
  fmt("mobile-banner", "Mobile Banner", 320, 50),
  fmt("square", "Square", 250, 250),
  fmt("large-rectangle", "Large Rectangle", 336, 280),
] as const;

/** What an unrecognised or absent `data-bs-slot` resolves to. */
export const DEFAULT_FORMAT_ID = "medium-rectangle";

const BY_ID = new Map(CREATIVE_FORMATS.map((f) => [f.id, f]));

/** Never throws — an unknown slug falls back, matching the SDK's behaviour. */
export function formatById(id: string | null | undefined): CreativeFormat {
  return BY_ID.get(id ?? "") ?? BY_ID.get(DEFAULT_FORMAT_ID)!;
}

export function isKnownFormat(id: string): boolean {
  return BY_ID.has(id);
}
