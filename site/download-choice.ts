/**
 * Which download the hero's button offers. The links themselves are published in the HTML by scripts/site-downloads.ts;
 * this only picks the device's own one as a shortcut, or the platform chooser when it cannot tell or nothing fits.
 * Pure: it reads what the browser says about the device and which files the page links, and touches no page.
 */

export type Os = "mac" | "linux" | "android";
export type Arch = "arm64" | "x64";

/** The device as the page can tell it: no operating system when it is one banda has no download for. */
export interface Device {
	readonly os: Os | null;
	readonly arch: Arch;
}

/** What `navigator` says, the parts the choice reads. */
export interface Navigated {
	readonly userAgent: string;
	readonly platform?: string;
	readonly maxTouchPoints?: number;
	readonly userAgentData?: { readonly platform?: string };
}

/** The button's target and words. */
export interface Choice {
	readonly href: string;
	readonly label: string;
}

const CHOOSER: Choice = { href: "#downloads", label: "Choose your platform" };
const RELEASES: Choice = { href: "https://github.com/purrgrammer/banda/releases", label: "View releases" };
const EXTENSION = { mac: "dmg", linux: "deb", android: "apk" } as const;
const NAME = { mac: "macOS (Apple silicon)", linux: "Linux (Debian, Ubuntu, x64)", android: "Android" } as const;

export function detectDevice(navigated: Navigated): Device {
	const ua = navigated.userAgent;
	const platform = (navigated.userAgentData?.platform || navigated.platform || "").toLowerCase();
	let os: Os | null =
		/mac/.test(platform) || /Mac OS X/.test(ua) ? "mac" : /linux/.test(platform) || /Linux/.test(ua) ? "linux" : null;
	if (/Android/.test(ua)) os = "android";
	else if (/iPhone|iPad/.test(ua) || (/mac/.test(platform) && (navigated.maxTouchPoints ?? 0) > 1)) os = null;
	const arch: Arch =
		os === "mac" || os === "android" ? "arm64" : /aarch64|arm64|armv[5-8]/i.test(`${platform} ${ua}`) ? "arm64" : "x64";
	return { os, arch };
}

/** The device once the browser's high-entropy `architecture` is known; a phone's stays what its user agent said. */
export function withArchitecture(device: Device, architecture: string | undefined): Device {
	if (!architecture || device.os === null || device.os === "android") return device;
	return { ...device, arch: architecture === "arm" ? "arm64" : "x64" };
}

/** The page's `data-file` key for a device's own download. */
export function fileOf(device: Device & { readonly os: Os }): string {
	return `${device.os === "android" ? "phone" : "desktop"}/${device.os}/${device.arch}/${EXTENSION[device.os]}`;
}

/** The button for a device, given the href the page links for a `data-file` key, if it links one. */
export function pickDownload(device: Device, linked: (file: string) => string | undefined): Choice {
	if (device.os === null) return CHOOSER;
	const href = linked(fileOf({ ...device, os: device.os }));
	if (href === undefined) return device.os === "linux" && device.arch === "x64" ? RELEASES : CHOOSER;
	return { href, label: `Download for ${NAME[device.os]}` };
}
