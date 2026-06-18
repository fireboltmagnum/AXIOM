// AXIOM brand marks — the user's real logo images. White variants for the dark
// UI; black variants for light surfaces (e.g. the Dashboard sidebar). Vite
// bundles these PNG imports and gives us hashed URLs.

import markWhite from "../assets/axiom-mark-white.png";
import markBlack from "../assets/axiom-mark-black.png";
import wordmarkWhite from "../assets/axiom-wordmark-white.png";
import wordmarkBlack from "../assets/axiom-wordmark-black.png";

type LogoProps = {
	className?: string;
	/** Rendered height in px. Width scales to the image's aspect ratio. */
	size?: number;
	/** Use the black variant for light backgrounds. Defaults to white (dark UI). */
	dark?: boolean;
	title?: string;
};

/** The 5-dot quincunx circle mark. Trimmed art is 594x563 (~square). */
export function AxiomMark({ className, size = 20, dark = false, title = "AXIOM" }: LogoProps) {
	const width = Math.round((size * 594) / 563);
	return (
		<img
			className={className}
			src={dark ? markBlack : markWhite}
			width={width}
			height={size}
			alt={title}
			draggable={false}
		/>
	);
}

/** The full AXIOM wordmark. Trimmed art is 1129x152 (~7.4:1). */
export function AxiomWordmark({ className, size = 16, dark = false, title = "AXIOM" }: LogoProps) {
	const width = Math.round((size * 1129) / 152);
	return (
		<img
			className={className}
			src={dark ? wordmarkBlack : wordmarkWhite}
			width={width}
			height={size}
			alt={title}
			draggable={false}
		/>
	);
}
