/** Whether the app is at phone width, kept as the window changes: what opens as a sheet from below instead of a dialog. */
import { useEffect, useState } from "react";

const PHONE = "(max-width: 767px)";

export function usePhone(): boolean {
	const [phone, setPhone] = useState(() => matchMedia(PHONE).matches);
	useEffect(() => {
		const list = matchMedia(PHONE);
		const changed = () => setPhone(list.matches);
		list.addEventListener("change", changed);
		return () => list.removeEventListener("change", changed);
	}, []);
	return phone;
}
