/** This browser's view preferences; activity disclosure belongs to an open message, never a global mode. */
import { useSyncExternalStore } from "react";

/** `theme`: light, dark, or the system's; a class on <html> (`.light`, `.dark`, none for the system's), which theme.css reads. */
export type Theme = "system" | "light" | "dark";

const THEME = "banda.theme";
const themeListeners = new Set<() => void>();
let theme: Theme = (() => {
	try {
		const saved = localStorage.getItem(THEME);
		return saved === "light" || saved === "dark" ? saved : "system";
	} catch {
		return "system";
	}
})();

/** Put this browser's theme on the page: once before the first render, and on every change. */
export function applyTheme(): void {
	document.documentElement.classList.toggle("light", theme === "light");
	document.documentElement.classList.toggle("dark", theme === "dark");
}

export function setTheme(next: Theme): void {
	theme = next;
	try {
		if (next === "system") localStorage.removeItem(THEME);
		else localStorage.setItem(THEME, next);
	} catch {
		// no storage: the choice lasts as long as the page
	}
	applyTheme();
	for (const listener of themeListeners) listener();
}

export function useTheme(): Theme {
	return useSyncExternalStore(
		(listener) => {
			themeListeners.add(listener);
			return () => themeListeners.delete(listener);
		},
		() => theme,
	);
}

export const THEMES: readonly { readonly value: Theme; readonly label: string }[] = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];
