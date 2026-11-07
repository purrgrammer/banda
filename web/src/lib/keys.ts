/** The platform's modifier, for labels: Apple keyboards show "⌘", the rest "Ctrl". One place, so every label agrees. */
export const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

export const MOD = MAC ? "⌘" : "Ctrl";

/** A shortcut with the modifier, as a label: "⌘K" on Apple, "Ctrl+K" elsewhere. */
export const withMod = (key: string) => (MAC ? `${MOD}${key}` : `${MOD}+${key}`);
