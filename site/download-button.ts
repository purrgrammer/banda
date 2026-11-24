// The hero's download button: the device's own download once it is known (site/download-choice.ts), else the chooser.
import { type Device, detectDevice, type Navigated, pickDownload, withArchitecture } from "./download-choice.ts";

type HighEntropy = { getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> };

const label = document.getElementById("download-label");
const button = document.getElementById("download");
if (label && button instanceof HTMLAnchorElement) {
	const linked = (file: string) => document.querySelector<HTMLAnchorElement>(`a[data-file="${file}"][href]`)?.href;
	const choose = (device: Device) => {
		const choice = pickDownload(device, linked);
		button.href = choice.href;
		label.textContent = choice.label;
	};
	const navigated = navigator as Navigator & Navigated & { readonly userAgentData?: HighEntropy };
	const device = detectDevice(navigated);
	choose(device);
	if (device.os !== null)
		try {
			const high = await navigated.userAgentData?.getHighEntropyValues?.(["architecture"]);
			choose(withArchitecture(device, high?.architecture));
		} catch {}
}
