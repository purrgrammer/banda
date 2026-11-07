/**
 * The API's shapes for the band's own file, `band.md` (`../../core/band.ts`): what is pinned to the top of the band.
 * Re-exported by `../api.ts`.
 */

/**
 * `GET /api/band`: the pins, in the owner's order, each an agent's id or `group:<room>`. `unavailable` when the box
 * could not be read or the file is not one the daemon reads (a link, too big, not text): the pins are then Sancho's.
 */
export type BandView = { readonly pinned: readonly string[]; readonly unavailable?: true };

/**
 * `POST /api/band/pin`: pin an agent or a group (`pin`, as `BandView` names it) to the end of the row, or unpin it
 * (`on: false`). In effect at once; answers with the band as it is after. Refused when `band.md` is one the daemon does
 * not read (a link, too big, not text), so such a file is never overwritten.
 */
export type BandPin = { readonly pin: string; readonly on: boolean };

/** The band, pushed on the shell stream whenever it changes. */
export type BandShellEvent = { readonly type: "band"; readonly band: BandView };
