// "Find family": pick which properties of a reference seed must
// stay (nearly) the same, and turn those choices into search conditions.
//
// Rows ("locks") are grouped in the order the QQL algorithm decides things.
// The search checks them in that same order and drops a seed at the first
// failure, so cheap early groups filter out most seeds before anything
// expensive is computed. Values come from the backend (`stats.family`), which
// uses the same code to check candidates — reference and search can't drift.

import type { FamilyConstraint, FamilyValues, TraitChoices, TraitsWire } from './api';

/** What to keep from the reference (step 1 of the start). */
export type Aspect = 'composition' | 'colors' | 'both';
/** How close hits must be (step 2 of the start). */
export type Closeness = 'wide' | 'middle' | 'close';
export type LockAspect = 'composition' | 'colors';
export type GroupId = 'flow' | 'spacing' | 'colors' | 'structure' | 'result';

export const ASPECTS: { id: Aspect; label: string; hint: string }[] = [
	{ id: 'composition', label: 'Composition', hint: 'shape, flow and structure; colors free' },
	{ id: 'colors', label: 'Colors', hint: 'palette look and accents; shape free' },
	{ id: 'both', label: 'Both', hint: 'composition and colors' }
];
export const CLOSENESS: { id: Closeness; label: string; hint: string }[] = [
	{ id: 'wide', label: 'Wide', hint: 'recognisably related, lots of variety, fast' },
	{ id: 'middle', label: 'Middle', hint: 'clearly the same idea' },
	{ id: 'close', label: 'Close', hint: 'near twins, slow to find' }
];

/** Plain explanation behind the ⓘ: what it is, what you see, and a tip. */
export type Info = { what: string; see: string; tip: string };

export type GroupMeta = {
	id: GroupId;
	title: string;
	cost: string;
	costClass: 'instant' | 'fast' | 'slow';
	/** Backend stages (family.rs STAGE_*) whose rejects count for this group. */
	stages: number[];
	info: Info;
};

export const GROUPS: GroupMeta[] = [
	{
		id: 'flow',
		title: 'Flow',
		cost: 'instant',
		costClass: 'instant',
		stages: [1],
		info: {
			what: 'The direction every line of dots follows: one angle for straight flows, or a swirl with a center, a direction and an amount of curl. Turbulence adds bumps that bend the lines.',
			see: 'This is the "movement" of the piece. Two seeds with the same swirl center and curl feel like the same gesture, even with different colors.',
			tip: 'Checked first and costs almost nothing, so keeping these strict is cheap per seed — but each one makes hits rarer.'
		}
	},
	{
		id: 'spacing',
		title: 'Spacing & size',
		cost: 'instant',
		costClass: 'instant',
		stages: [2],
		info: {
			what: 'How big the circles start, how much room they keep between each other, and whether some groups of lines ignore the flow and run straight.',
			see: 'Airy versus packed. A piece with wide spacing shows the background between the dots; a dense one reads as a solid texture.',
			tip: 'Also nearly free to check. Spacing is one of the strongest "same feel" properties.'
		}
	},
	{
		id: 'colors',
		title: 'Colors',
		cost: 'instant',
		costClass: 'instant',
		stages: [2, 5],
		info: {
			what: 'The background, the first colors the lines start with, how often colors change, and splatter: extra circles painted over in an accent color.',
			see: 'The contrast you notice first. A cream grid with yellow accents keeps that look only if background, main colors and splatter stay the same.',
			tip: 'Needs the palette (and for some rows the color variety) set in Traits — the panel says when one is missing. Checked before any layout, so it is fast.'
		}
	},
	{
		id: 'structure',
		title: 'Structure',
		cost: 'fast',
		costClass: 'fast',
		stages: [3, 4],
		info: {
			what: 'Where the lines start: a Formation grid, Orbital rings or Shadows circles, and their settings (grid size, ring center, band size, number of circles).',
			see: 'The skeleton of the piece: columns of dots, arcs around a center, or clusters.',
			tip: 'The settings are checked instantly; building the actual rings or grid takes a few milliseconds, still before any dots are placed.'
		}
	},
	{
		id: 'result',
		title: 'Result',
		cost: 'slow · only for survivors',
		costClass: 'slow',
		stages: [6],
		info: {
			what: 'What only exists after all dots are placed: how many there are, how big they turned out, which colors were used, and where the canvas is full or empty.',
			see: 'The overall weight of the piece. With Size variety Wild, the circle sizes are decided here, by chance.',
			tip: 'A full layout can take up to a second, so these run only for seeds that passed everything above. Keep them loose unless the result looks wrong.'
		}
	}
];

/** Value shown for a lock and used to build its condition. */
export type RefValue = number | string | [number, number] | string[] | number[];

export type LockDef = {
	id: string;
	label: string;
	group: GroupId;
	aspect: LockAspect;
	/** Collapsed under "More" — little visible effect on its own. */
	advanced?: boolean;
	/**
	 * range:  number within ± tolerance (abs) or ± tolerance × value (rel).
	 * exact:  number, must match.
	 * mirror: Orbital center; tolerance 1 = value or its mirror image, 0 = exact.
	 * equals: text, must match.
	 * near:   2-D point within a radius (canvas widths).
	 * pair:   two texts, both must match.
	 * set:    same set of colors.
	 * grid:   3×3 coverage map, each cell within ± tolerance (percent points).
	 */
	kind: 'range' | 'exact' | 'mirror' | 'equals' | 'near' | 'pair' | 'set' | 'grid';
	keys: string[];
	tolMode?: 'abs' | 'rel';
	/** Tolerance per closeness; null = off at that closeness. */
	tol: Record<Closeness, number | null>;
	/** Tolerance when switched on by hand. */
	defaultTol: number;
	tolStep?: number;
	unit?: string;
	/** Traits that must be fixed (same as the reference) for this to apply. */
	needs?: (keyof TraitChoices)[];
	/** Extra condition on the reference for the row to make sense. */
	applies?: (v: FamilyValues, t: TraitsWire) => boolean;
	format?: (v: RefValue) => string;
	/** Shorter name for the summary line. */
	short?: string;
	info: Info;
};

export type LockState = { on: boolean; tol: number };

// ---- formatting helpers ------------------------------------------------------

const fix = (v: number, d = 2) => (Number.isInteger(v) ? String(v) : v.toFixed(d));
const pctOf = (v: number) => `${Math.round(v * 100)}%`;

// Orbital ring centers come from a fixed set; these pairs mirror each other.
const MIRROR_PAIRS: [number, number][] = [
	[0.333, 0.666],
	[-0.333, 1.333],
	[-1.6, 1.6],
	[0.5, 0.5]
];
const near = (a: number, b: number) => Math.abs(a - b) < 0.002;
export function mirrorOf(v: number): number {
	for (const [a, b] of MIRROR_PAIRS) {
		if (near(v, a)) return b;
		if (near(v, b)) return a;
	}
	return v;
}
function fracLabel(v: number): string {
	if (near(v, 0.5)) return '½';
	if (near(v, 0.333)) return '⅓';
	if (near(v, 0.666)) return '⅔';
	if (near(v, -0.333)) return '−⅓ (off)';
	if (near(v, 1.333)) return '4/3 (off)';
	if (near(v, -1.6)) return 'far off';
	if (near(v, 1.6)) return 'far off';
	return v.toFixed(2);
}
/** "top left", "middle", "below the canvas"… for a point in canvas fractions. */
export function placeName(x: number, y: number): string {
	const h = x < -0.02 ? 'left of canvas' : x > 1.02 ? 'right of canvas' : x < 0.34 ? 'left' : x > 0.66 ? 'right' : 'center';
	const v = y < -0.02 ? 'above canvas' : y > 1.02 ? 'below canvas' : y < 0.34 ? 'top' : y > 0.66 ? 'bottom' : 'middle';
	if (v === 'middle' && h === 'center') return 'middle';
	return `${v} ${h}`.replace('middle ', '');
}
const pointText = (v: RefValue) => {
	const [x, y] = v as [number, number];
	return `${placeName(x, y)} (${x.toFixed(2)}, ${y.toFixed(2)})`;
};
export function splatterLevel(odds: number): string {
	if (odds <= 0) return 'none';
	if (odds <= 0.002) return 'trace';
	if (odds <= 0.005) return 'light';
	if (odds <= 0.01) return 'moderate';
	if (odds <= 0.03) return 'heavy';
	if (odds <= 0.08) return 'very heavy';
	return 'extreme';
}
/** Short color name: palette prefix dropped ("fNewsprint" → "Newsprint"). */
export const colorShort = (c: string) => c.replace(/^[a-z](?=[A-Z])/, '');

// ---- the rows -----------------------------------------------------------------

export const LOCKS: LockDef[] = [
	// ---- Flow ------------------------------------------------------------------
	{
		id: 'flowAngle',
		label: 'Line angle',
		short: 'angle',
		group: 'flow',
		aspect: 'composition',
		kind: 'range',
		keys: ['flowAngle'],
		tolMode: 'abs',
		tol: { wide: 6, middle: 3, close: 1.5 },
		defaultTol: 3,
		tolStep: 0.5,
		unit: '°',
		needs: ['flowField'],
		applies: (_v, t) => t.flowField === 'RandomLinear',
		format: (v) => `${(v as number).toFixed(1)}°`,
		info: {
			what: 'The direction of the straight lines, from 0° (horizontal) to 90° (vertical). Only "Random linear" flows have a free angle; Horizontal, Diagonal and Vertical are fixed.',
			see: 'Lines at 20° and lines at 35° give a clearly different slant.',
			tip: '±3° keeps the slant recognisable.'
		}
	},
	{
		id: 'flowCenter',
		label: 'Swirl center',
		short: 'swirl',
		group: 'flow',
		aspect: 'composition',
		kind: 'near',
		keys: ['flowCenterX', 'flowCenterY'],
		tol: { wide: 0.3, middle: 0.15, close: 0.08 },
		defaultTol: 0.15,
		tolStep: 0.01,
		needs: ['flowField'],
		format: pointText,
		info: {
			what: 'The point the lines curl around in a radial flow (Explosive, Spiral, Circular). It is often off the canvas, so you may only see an arc.',
			see: 'A swirl whose eye sits top left reads completely differently from one centered low on the canvas.',
			tip: 'The tolerance is a distance in canvas widths: 0.1 is a tenth of the width. This is usually the row that decides how rare a radial family is.'
		}
	},
	{
		id: 'flowDirection',
		label: 'Flow direction',
		short: '',
		group: 'flow',
		aspect: 'composition',
		kind: 'equals',
		keys: ['flowDirection'],
		tol: { wide: 0, middle: 0, close: 0 },
		defaultTol: 0,
		needs: ['flowField'],
		format: (v) => (v === 'in' ? 'inward' : 'outward'),
		info: {
			what: 'Whether the radial lines flow in toward the swirl center or out from it.',
			see: 'Inward feels like water draining; outward like an explosion.',
			tip: 'Half of all radial seeds go each way, so this costs a factor 2.'
		}
	},
	{
		id: 'flowRotation',
		label: 'Turning direction',
		short: '',
		group: 'flow',
		aspect: 'composition',
		kind: 'equals',
		keys: ['flowRotation'],
		tol: { wide: 0, middle: 0, close: 0 },
		defaultTol: 0,
		needs: ['flowField'],
		format: (v) => (v === 'ccw' ? 'counter-clockwise' : 'clockwise'),
		info: {
			what: 'Whether the swirl turns clockwise or counter-clockwise.',
			see: 'A mirror image of the same swirl — clearly related, but not the same.',
			tip: 'Costs a factor 2. Switch it off if a mirrored family is fine.'
		}
	},
	{
		id: 'flowCircularity',
		label: 'Curl',
		short: 'curl',
		group: 'flow',
		aspect: 'composition',
		kind: 'range',
		keys: ['flowCircularity'],
		tolMode: 'abs',
		tol: { wide: 0.12, middle: 0.08, close: 0.04 },
		defaultTol: 0.08,
		tolStep: 0.01,
		needs: ['flowField'],
		format: (v) => (v as number).toFixed(2),
		info: {
			what: 'How strongly the radial lines curl: 0 is straight in or out, 1 is perfect circles.',
			see: 'Explosive pieces sit around 0.3, spirals around 0.6, circular ones near 1.',
			tip: '±0.05 keeps the same kind of spiral.'
		}
	},
	{
		id: 'turbCount',
		label: 'Turbulence spots',
		short: 'bumps',
		group: 'flow',
		aspect: 'composition',
		kind: 'range',
		keys: ['turbCount'],
		tolMode: 'abs',
		tol: { wide: null, middle: 10, close: 5 },
		defaultTol: 5,
		tolStep: 1,
		needs: ['turbulence'],
		applies: (v) => (v.nums.turbCount ?? 0) > 0,
		format: (v) => String(v),
		info: {
			what: 'How many bumps disturb the flow (10–30 for Low, 20–60 for High turbulence).',
			see: 'More spots give a busier, wavier piece.',
			tip: 'Where each spot lands is pure chance and not part of this row — see "Strongest bump" for the one that matters most.'
		}
	},
	{
		id: 'turbStrength',
		label: 'Turbulence strength',
		short: 'bump strength',
		group: 'flow',
		aspect: 'composition',
		kind: 'exact',
		keys: ['turbStrength'],
		tol: { wide: null, middle: 0, close: 0 },
		defaultTol: 0,
		needs: ['turbulence'],
		applies: (v) => (v.nums.turbCount ?? 0) > 0,
		format: (v) => `${(v as number).toFixed(1)}°`,
		info: {
			what: 'How hard each bump bends the lines. High turbulence picks 9°, 18° or 27°; Low picks 0.9° or 1.8°.',
			see: '27° bumps throw the lines around; 9° bumps only ripple them.',
			tip: 'One of a few fixed values, so this costs a factor 2–3.'
		}
	},
	{
		id: 'spot1',
		label: 'Strongest bump',
		short: 'strongest bump',
		group: 'flow',
		aspect: 'composition',
		advanced: true,
		kind: 'near',
		keys: ['spot1X', 'spot1Y'],
		tol: { wide: null, middle: null, close: 0.15 },
		defaultTol: 0.15,
		tolStep: 0.01,
		needs: ['turbulence'],
		applies: (v) => (v.nums.turbCount ?? 0) > 0,
		format: pointText,
		info: {
			what: 'Where the most powerful turbulence bump sits (largest angle × size).',
			see: 'Helps when one bump visibly bends a whole area of the piece. With dozens of similar bumps it hardly matters.',
			tip: 'Every bump position is random, so this makes hits much rarer. Use it only when one bump stands out.'
		}
	},

	// ---- Spacing & size --------------------------------------------------------------
	{
		id: 'spacingMult',
		label: 'Spacing',
		short: 'spacing',
		group: 'spacing',
		aspect: 'composition',
		kind: 'range',
		keys: ['spacingMult'],
		tolMode: 'rel',
		tol: { wide: 0.15, middle: 0.1, close: 0.07 },
		defaultTol: 0.1,
		tolStep: 0.01,
		needs: ['spacing'],
		format: (v) => `×${(v as number).toFixed(2)}`,
		info: {
			what: 'The room each circle keeps around itself, as a multiple of its size.',
			see: '×1.0 packs circles edge to edge; ×1.5 leaves clear gaps between them.',
			tip: 'The tolerance is relative: 0.10 means ±10% of the reference value.'
		}
	},
	{
		id: 'ignoreOdds',
		label: 'Straight-line groups',
		short: 'straight groups',
		group: 'spacing',
		aspect: 'composition',
		kind: 'exact',
		keys: ['ignoreOdds'],
		tol: { wide: 0, middle: 0, close: 0 },
		defaultTol: 0,
		format: (v) => ((v as number) === 0 ? 'none' : `${pctOf(v as number)} of groups`),
		info: {
			what: 'The chance that a group of lines ignores the flow and runs straight.',
			see: 'At 0 every line follows the swirl; at 0.8 most lines run straight and the swirl almost disappears.',
			tip: '"None" happens in 71% of seeds; 0.5, 0.8 and 0.9 are rare.'
		}
	},
	{
		id: 'scaleStart',
		label: 'Starting circle size',
		short: 'start size',
		group: 'spacing',
		aspect: 'composition',
		advanced: true,
		kind: 'range',
		keys: ['scaleStart'],
		tolMode: 'rel',
		tol: { wide: 0.4, middle: 0.25, close: 0.12 },
		defaultTol: 0.25,
		tolStep: 0.01,
		needs: ['ringSize', 'sizeVariety'],
		format: (v) => `${(v as number).toFixed(2)}%`,
		info: {
			what: 'The average circle size the lines start with, in percent of the canvas width.',
			see: 'Mostly decided by the Ring size trait; this narrows it further.',
			tip: 'With Size variety Wild the final sizes drift a lot, so this says less there.'
		}
	},
	{
		id: 'ringDensity',
		label: 'Ring fill',
		short: 'ring fill',
		group: 'spacing',
		aspect: 'composition',
		advanced: true,
		kind: 'range',
		keys: ['ringDensity'],
		tolMode: 'abs',
		tol: { wide: null, middle: null, close: 0.08 },
		defaultTol: 0.1,
		tolStep: 0.01,
		needs: ['ringThickness'],
		format: (v) => (v as number).toFixed(2),
		info: {
			what: 'How solid the rings inside each circle are drawn: low values give thin bands with gaps, high values nearly solid discs.',
			see: 'Fine target-like circles versus chunky, almost flat dots.',
			tip: 'Mostly set by the Ring thickness trait; this fine-tunes it.'
		}
	},

	// ---- Colors ------------------------------------------------------------------------
	{
		id: 'background',
		label: 'Background',
		short: 'background',
		group: 'colors',
		aspect: 'colors',
		kind: 'equals',
		keys: ['background'],
		tol: { wide: 0, middle: 0, close: 0 },
		defaultTol: 0,
		needs: ['colorPalette'],
		format: (v) => String(v),
		info: {
			what: 'The canvas color behind the circles.',
			see: 'The single biggest color area of most pieces.',
			tip: 'Each palette has 2–6 backgrounds; Austin picks each 25% of the time.'
		}
	},
	{
		id: 'startColors',
		label: 'Main colors',
		short: '',
		group: 'colors',
		aspect: 'colors',
		kind: 'pair',
		keys: ['startPrimary', 'startSecondary'],
		tol: { wide: null, middle: 0, close: 0 },
		defaultTol: 0,
		needs: ['colorPalette'],
		format: (v) => (v as string[]).map(colorShort).join(' + '),
		info: {
			what: 'The color pair the first group of lines starts with (fill + second color, used by Zebra and Stacked).',
			see: 'In pieces with few color changes — like a uniform grid — this pair is the whole look: cream with dark brown stays cream with dark brown.',
			tip: 'With many color changes the start pair matters less; check "Color changes" too.'
		}
	},
	{
		id: 'colorChangeGroup',
		label: 'Color changes',
		short: 'color changes',
		group: 'colors',
		aspect: 'colors',
		kind: 'range',
		keys: ['colorChangeGroup'],
		tolMode: 'abs',
		tol: { wide: 0.2, middle: 0.15, close: 0.08 },
		defaultTol: 0.1,
		tolStep: 0.05,
		needs: ['colorVariety', 'structure'],
		format: (v) => pctOf(v as number),
		info: {
			what: 'The chance that the color changes from one group of lines to the next.',
			see: 'Low: big areas in one color. High: a patchwork of colors.',
			tip: 'Absolute tolerance: 0.10 means ±10 percentage points.'
		}
	},
	{
		id: 'colorChangeLine',
		label: 'Color stripes',
		short: 'stripes',
		group: 'colors',
		aspect: 'colors',
		kind: 'range',
		keys: ['colorChangeLine'],
		tolMode: 'abs',
		tol: { wide: null, middle: null, close: 0.03 },
		defaultTol: 0.03,
		tolStep: 0.01,
		needs: ['colorVariety', 'structure'],
		format: (v) => ((v as number) === 0 ? 'never' : pctOf(v as number)),
		info: {
			what: 'The chance that the color changes from one line to the next within a group.',
			see: '"Never" keeps whole groups in one color; higher values give stripes.',
			tip: 'About a third of seeds never change color within a group.'
		}
	},
	{
		id: 'primarySeq',
		label: 'Color set',
		short: 'color set',
		group: 'colors',
		aspect: 'colors',
		advanced: true,
		kind: 'set',
		keys: ['primarySeq'],
		tol: { wide: null, middle: null, close: null },
		defaultTol: 0,
		needs: ['colorPalette', 'colorVariety'],
		format: (v) => `${(v as string[]).length} colors`,
		info: {
			what: 'Exactly which palette colors the piece can use for its rings.',
			see: 'Same palette, same color set: only the order and amounts differ.',
			tip: 'Very strict: with high color variety only a handful in a million seeds share the exact set. Off in every start choice; "Main colors" is usually enough.'
		}
	},
	{
		id: 'splatterOdds',
		label: 'Splatter amount',
		short: 'splatter',
		group: 'colors',
		aspect: 'colors',
		kind: 'exact',
		keys: ['splatterOdds'],
		tol: { wide: 0, middle: 0, close: 0 },
		defaultTol: 0,
		needs: ['colorVariety'],
		format: (v) => `${splatterLevel(v as number)} (${v})`,
		info: {
			what: 'After drawing, some circles are painted over again in an accent color. This is how often.',
			see: '"Extreme" turns about 1 in 6 circles into accents, like yellow dots scattered over a cream grid; "light" gives a handful.',
			tip: 'Extreme only happens with High color variety, in about 0.5% of seeds.'
		}
	},
	{
		id: 'splatterColors',
		label: 'Splatter colors',
		short: 'accents',
		group: 'colors',
		aspect: 'colors',
		kind: 'set',
		keys: ['splatterColors'],
		tol: { wide: null, middle: null, close: 0 },
		defaultTol: 0,
		needs: ['colorPalette'],
		applies: (v) => (v.nums.splatterOdds ?? 0) > 0,
		format: (v) => (v as string[]).map(colorShort).join(', '),
		info: {
			what: 'Which accent color(s) the splatter uses.',
			see: 'Yellow accents and red accents give a very different contrast on the same base.',
			tip: 'Most seeds pick one or two accent colors from a short palette list.'
		}
	},
	{
		id: 'splatterCenter',
		label: 'Splatter focus',
		short: 'splatter focus',
		group: 'colors',
		aspect: 'colors',
		kind: 'near',
		keys: ['splatterX', 'splatterY'],
		tol: { wide: null, middle: null, close: 0.3 },
		defaultTol: 0.3,
		tolStep: 0.05,
		applies: (v) => (v.nums.splatterOdds ?? 0) > 0,
		format: pointText,
		info: {
			what: 'Splatter is most likely near one random point and fades with distance. This is that point.',
			see: 'Accents bunched at the top versus spread toward the bottom.',
			tip: 'Distance in canvas widths. Only matters when there is clearly visible splatter.'
		}
	},

	// ---- Structure ---------------------------------------------------------------------
	{
		id: 'formH',
		label: 'Columns',
		short: 'columns',
		group: 'structure',
		aspect: 'composition',
		kind: 'exact',
		keys: ['formH'],
		tol: { wide: 0, middle: 0, close: 0 },
		defaultTol: 0,
		needs: ['structure'],
		format: (v) => String(v),
		info: {
			what: 'How many blocks the Formation grid has across.',
			see: '1 column gives one big field of lines; 4 columns give four separate blocks side by side.',
			tip: '1 column is by far the most common (47%).'
		}
	},
	{
		id: 'formV',
		label: 'Rows',
		short: 'rows',
		group: 'structure',
		aspect: 'composition',
		kind: 'exact',
		keys: ['formV'],
		tol: { wide: 0, middle: 0, close: 0 },
		defaultTol: 0,
		needs: ['structure'],
		format: (v) => String(v),
		info: {
			what: 'How many blocks the Formation grid has from top to bottom.',
			see: 'Together with Columns this sets the grid, e.g. 1 × 1 or 3 × 2.',
			tip: 'Fixed choices, so keep it exact.'
		}
	},
	{
		id: 'formStep',
		label: 'Point spacing',
		short: 'step',
		group: 'structure',
		aspect: 'composition',
		kind: 'exact',
		keys: ['formStep'],
		tol: { wide: 0, middle: 0, close: 0 },
		defaultTol: 0,
		needs: ['structure'],
		format: (v) => `${fix(v as number)}%`,
		info: {
			what: 'The distance between the starting points of lines inside a Formation block.',
			see: 'Small steps give many thin lines close together; large steps give few, separate lines.',
			tip: '0.75% and 1% are common; 4% and 8% are rare.'
		}
	},
	{
		id: 'formSkip',
		label: 'Gaps',
		short: 'gaps',
		group: 'structure',
		aspect: 'composition',
		kind: 'exact',
		keys: ['formSkip'],
		tol: { wide: null, middle: null, close: 0 },
		defaultTol: 0,
		needs: ['structure'],
		format: (v) => ((v as number) === 0 ? 'none' : pctOf(v as number)),
		info: {
			what: 'The chance that a grid block is left out.',
			see: 'Missing blocks leave empty patches in the grid.',
			tip: 'Only visible with several blocks.'
		}
	},
	{
		id: 'orbCx',
		label: 'Ring center across',
		short: 'center across',
		group: 'structure',
		aspect: 'composition',
		kind: 'mirror',
		keys: ['orbCx'],
		tol: { wide: 1, middle: 0, close: 0 },
		defaultTol: 0,
		needs: ['structure'],
		format: (v) => fracLabel(v as number),
		info: {
			what: 'Where the center of the Orbital rings sits from left to right. It comes from a fixed set of positions, several of them off the canvas.',
			see: 'Arcs bending around the right edge versus full rings around the middle.',
			tip: '"mirror ok" also accepts the mirrored position (left ↔ right), which doubles the hits.'
		}
	},
	{
		id: 'orbCy',
		label: 'Ring center down',
		short: 'center down',
		group: 'structure',
		aspect: 'composition',
		kind: 'mirror',
		keys: ['orbCy'],
		tol: { wide: 1, middle: 0, close: 0 },
		defaultTol: 0,
		needs: ['structure'],
		format: (v) => fracLabel(v as number),
		info: {
			what: 'Where the center of the Orbital rings sits from top to bottom.',
			see: 'A center below the canvas gives arcs rising from the bottom.',
			tip: '"mirror ok" also accepts top ↔ bottom.'
		}
	},
	{
		id: 'orbThickness',
		label: 'Band thickness',
		short: 'bands',
		group: 'structure',
		aspect: 'composition',
		kind: 'exact',
		keys: ['orbThickness'],
		tol: { wide: null, middle: 0, close: 0 },
		defaultTol: 0,
		needs: ['structure'],
		format: (v) => `${fix(v as number, 0)}%`,
		info: {
			what: 'How wide each band of rings is (7%, 15% or 30% of the canvas).',
			see: 'Thin bands give many narrow arcs; thick bands a few broad ones.',
			tip: 'Three equally likely values: a factor 3.'
		}
	},
	{
		id: 'orbStep',
		label: 'Ring point spacing',
		short: 'ring spacing',
		group: 'structure',
		aspect: 'composition',
		kind: 'exact',
		keys: ['orbStep'],
		tol: { wide: 0, middle: 0, close: 0 },
		defaultTol: 0,
		needs: ['structure'],
		format: (v) => `${fix(v as number, 0)}%`,
		info: {
			what: 'The distance between lines along each ring.',
			see: '1–2% gives dense rings of lines; 8–16% gives sparse spokes.',
			tip: 'Strongly visible; keep it exact.'
		}
	},
	{
		id: 'orbOffset',
		label: 'Split rotation',
		short: 'rotation',
		group: 'structure',
		aspect: 'composition',
		advanced: true,
		kind: 'range',
		keys: ['orbOffset'],
		tolMode: 'abs',
		tol: { wide: null, middle: null, close: 30 },
		defaultTol: 30,
		tolStep: 5,
		unit: '°',
		needs: ['structure'],
		format: (v) => `${(v as number).toFixed(0)}°`,
		info: {
			what: 'How far the split points of the rings are rotated.',
			see: 'Barely visible on its own.',
			tip: 'Leave off unless two otherwise identical hits look rotated.'
		}
	},
	{
		id: 'shTarget',
		label: 'Target circles',
		short: 'clusters',
		group: 'structure',
		aspect: 'composition',
		kind: 'exact',
		keys: ['shTarget'],
		tol: { wide: 0, middle: 0, close: 0 },
		defaultTol: 0,
		needs: ['structure'],
		format: (v) => String(v),
		info: {
			what: 'How many circle clusters a Shadows piece aims for (5, 7, 10, 20, 30 or 60).',
			see: 'A few big clusters versus many small ones.',
			tip: 'Where the clusters land is random and not part of this row.'
		}
	},
	{
		id: 'shSquare',
		label: 'Fill style',
		short: 'fill',
		group: 'structure',
		aspect: 'composition',
		kind: 'exact',
		keys: ['shSquare'],
		tol: { wide: null, middle: 0, close: 0 },
		defaultTol: 0,
		needs: ['structure'],
		format: (v) => ((v as number) <= 0.1 ? 'radial' : (v as number) >= 0.9 ? 'square' : 'mixed'),
		info: {
			what: 'Whether Shadows clusters are filled in rings (radial), in rows (square) or a mix.',
			see: 'Round versus blocky clusters.',
			tip: 'Three values.'
		}
	},
	{
		id: 'curveLength',
		label: 'Line length',
		short: 'line length',
		group: 'structure',
		aspect: 'composition',
		advanced: true,
		kind: 'exact',
		keys: ['curveLength'],
		tol: { wide: null, middle: null, close: 0 },
		defaultTol: 0,
		format: (v) => String(v),
		info: {
			what: 'How many steps each line may take (500, 650 or 850).',
			see: 'Longer lines reach further across the canvas.',
			tip: 'Subtle; a factor 3.'
		}
	},

	// ---- Result -----------------------------------------------------------------------
	{
		id: 'density',
		label: 'Full and empty areas',
		short: 'density map',
		group: 'result',
		aspect: 'composition',
		kind: 'grid',
		keys: ['grid'],
		tol: { wide: null, middle: 20, close: 12 },
		defaultTol: 20,
		tolStep: 1,
		unit: 'pt',
		info: {
			what: 'How much of each ninth of the canvas (3 × 3) is covered by circles, from 0% (empty) to about 80% (packed).',
			see: 'The "weight" of the piece: an empty corner, a packed middle, a heavy bottom.',
			tip: 'Tolerance in percentage points per square: 20 means each square may be 20 points fuller or emptier.'
		}
	},
	{
		id: 'points',
		label: 'Number of dots',
		short: 'dots',
		group: 'result',
		aspect: 'composition',
		kind: 'range',
		keys: ['points'],
		tolMode: 'rel',
		tol: { wide: null, middle: 0.4, close: 0.25 },
		defaultTol: 0.4,
		tolStep: 0.05,
		format: (v) => (v as number).toLocaleString(),
		info: {
			what: 'How many circles ended up on the canvas.',
			see: 'A few hundred feels sparse and graphic; tens of thousands reads as texture.',
			tip: 'Relative tolerance: 0.4 means ±40%. Seeds over the maximum are dropped as soon as they cross it.'
		}
	},
	{
		id: 'maxRadius',
		label: 'Largest circle',
		short: 'largest circle',
		group: 'result',
		aspect: 'composition',
		kind: 'range',
		keys: ['maxRadius'],
		tolMode: 'rel',
		tol: { wide: 0.5, middle: 0.3, close: 0.15 },
		defaultTol: 0.3,
		tolStep: 0.05,
		format: (v) => `${(v as number).toFixed(1)}%`,
		info: {
			what: 'The radius of the biggest circle, in percent of the canvas width.',
			see: 'One dominant circle draws the eye; without it the piece stays even.',
			tip: 'Seeds whose circles grow past the maximum are dropped right away.'
		}
	},
	{
		id: 'areaLarge',
		label: 'Area in large circles',
		short: 'large-circle area',
		group: 'result',
		aspect: 'composition',
		advanced: true,
		kind: 'range',
		keys: ['areaLarge'],
		tolMode: 'abs',
		tol: { wide: null, middle: null, close: 5 },
		defaultTol: 10,
		tolStep: 1,
		unit: '%',
		format: (v) => `${(v as number).toFixed(0)}%`,
		info: {
			what: 'The share of all circle area taken by large circles (radius over 3%).',
			see: 'Measured by area: one large circle covers as much as hundreds of small ones.',
			tip: 'Only meaningful with Size variety Variable or Wild.'
		}
	},
	{
		id: 'areaMedium',
		label: 'Area in medium circles',
		short: 'medium-circle area',
		group: 'result',
		aspect: 'composition',
		advanced: true,
		kind: 'range',
		keys: ['areaMedium'],
		tolMode: 'abs',
		tol: { wide: null, middle: null, close: 8 },
		defaultTol: 15,
		tolStep: 1,
		unit: '%',
		format: (v) => `${(v as number).toFixed(0)}%`,
		info: {
			what: 'The share of circle area taken by medium circles (radius 1.2–3%).',
			see: 'Together with large circles this sets the size mix.',
			tip: 'Absolute tolerance in percentage points.'
		}
	},
	{
		id: 'colorsUsed',
		label: 'Colors used',
		short: 'colors used',
		group: 'result',
		aspect: 'colors',
		advanced: true,
		kind: 'range',
		keys: ['colorsUsed'],
		tolMode: 'abs',
		tol: { wide: null, middle: null, close: 1 },
		defaultTol: 1,
		tolStep: 1,
		format: (v) => String(v),
		info: {
			what: 'How many different ring colors actually appear (splatter not counted).',
			see: 'A two-color piece stays calm; ten colors look lively.',
			tip: 'Needs the full layout, so it is slow. "Main colors" and "Color changes" are faster ways to the same look.'
		}
	}
];

export const lockById = (id: string) => LOCKS.find((l) => l.id === id);

/** The reference value of a row, or null when the seed doesn't have it. */
export function refValue(def: LockDef, v: FamilyValues): RefValue | null {
	switch (def.kind) {
		case 'near': {
			const x = v.nums[def.keys[0]];
			const y = v.nums[def.keys[1]];
			return x == null || y == null ? null : [x, y];
		}
		case 'pair': {
			const a = v.texts[def.keys[0]];
			const b = v.texts[def.keys[1]];
			return a == null || b == null ? null : [a, b];
		}
		case 'set':
			return v.sets[def.keys[0]] ?? null;
		case 'grid':
			return v.grid ?? null;
		case 'equals':
			return v.texts[def.keys[0]] ?? null;
		default:
			return v.nums[def.keys[0]] ?? null;
	}
}

export function formatRef(def: LockDef, val: RefValue): string {
	if (def.format) return def.format(val);
	if (def.kind === 'grid') return '3 × 3 map';
	if (typeof val === 'number') return fix(val);
	return String(val);
}

/** Lock states for a start choice. Rows outside the chosen aspect are off. */
export function startStates(aspect: Aspect, closeness: Closeness): Record<string, LockState> {
	const out: Record<string, LockState> = {};
	for (const d of LOCKS) {
		const t = d.tol[closeness];
		const inAspect = aspect === 'both' || d.aspect === aspect;
		out[d.id] = { on: inAspect && t !== null, tol: t ?? d.defaultTol };
	}
	return out;
}

/** Whether a row has an editable tolerance. */
export function hasTol(def: LockDef): boolean {
	return def.kind === 'range' || def.kind === 'near' || def.kind === 'grid';
}

/** The seed a row copies its value from: values plus traits. */
export type RefSource = { values: FamilyValues; traits: TraitsWire };

/**
 * Turn the switched-on rows into backend conditions. `refFor` picks the seed
 * whose values a row copies (two references can be mixed: composition from
 * one, colors from another). `skip` lists rows that can't apply right now.
 * Rows that don't apply to the reference (e.g. turbulence rows on a piece
 * without turbulence) are left out.
 */
export function buildConstraints(
	refFor: (def: LockDef) => RefSource | null,
	states: Record<string, LockState>,
	skip: Set<string> = new Set()
): { lockId: string; constraint: FamilyConstraint }[] {
	const out: { lockId: string; constraint: FamilyConstraint }[] = [];
	for (const d of LOCKS) {
		const st = states[d.id];
		if (!st || !st.on || skip.has(d.id)) continue;
		const src = refFor(d);
		if (!src || !rowApplies(d, src.values, src.traits)) continue;
		const v = refValue(d, src.values);
		if (v == null) continue;
		const tol = Math.max(0, Number.isFinite(st.tol) ? st.tol : d.defaultTol);
		const key = d.keys[0];
		const push = (c: FamilyConstraint) => out.push({ lockId: d.id, constraint: c });
		switch (d.kind) {
			case 'equals':
				push({ kind: 'equals', key, value: v as string });
				break;
			case 'pair': {
				const [a, b] = v as [string, string];
				push({ kind: 'equals', key: d.keys[0], value: a });
				push({ kind: 'equals', key: d.keys[1], value: b });
				break;
			}
			case 'set':
				push({ kind: 'sameSet', key, values: v as string[] });
				break;
			case 'grid':
				push({ kind: 'gridNear', values: v as number[], tol });
				break;
			case 'near': {
				const [x, y] = v as [number, number];
				push({ kind: 'near', kx: d.keys[0], ky: d.keys[1], x, y, radius: tol });
				break;
			}
			case 'exact': {
				const n = v as number;
				const eps = 1e-6 * Math.max(1, Math.abs(n));
				push({ kind: 'range', key, min: n - eps, max: n + eps });
				break;
			}
			case 'mirror': {
				const n = v as number;
				const values = tol >= 0.5 ? Array.from(new Set([n, mirrorOf(n)])) : [n];
				push({ kind: 'oneOf', key, values });
				break;
			}
			case 'range': {
				const n = v as number;
				const delta = d.tolMode === 'rel' ? Math.abs(n) * tol : tol;
				push({ kind: 'range', key, min: n - delta, max: n + delta });
				break;
			}
		}
	}
	return out;
}

/** Traits each row needs fixed; explains rows that are skipped. */
export const TRAIT_LABEL: Partial<Record<keyof TraitChoices, string>> = {
	flowField: 'Flow field',
	turbulence: 'Turbulence',
	structure: 'Structure',
	colorPalette: 'Color palette',
	colorVariety: 'Color variety',
	ringSize: 'Ring size',
	sizeVariety: 'Size variety',
	spacing: 'Spacing',
	ringThickness: 'Ring thickness'
};

/**
 * Rows that can't apply with the current trait choices, with the reason.
 * A row reads properties whose odds depend on certain traits; when such a
 * trait is left on Any (or set differently from the reference) the row's
 * reference value means nothing for the candidates.
 */
export function skippedRows(
	choices: TraitChoices,
	refTraitsFor: (def: LockDef) => TraitsWire
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const d of LOCKS) {
		const t = refTraitsFor(d) as unknown as Record<string, unknown>;
		for (const k of d.needs ?? []) {
			if ((choices as unknown as Record<string, unknown>)[k] !== t[k]) {
				out[d.id] = `${TRAIT_LABEL[k] ?? k} not set to ${String(t[k])} in Traits`;
				break;
			}
		}
	}
	return out;
}

/** Whether a row is shown at all for this reference. */
export function rowApplies(def: LockDef, v: FamilyValues, t: TraitsWire): boolean {
	if (refValue(def, v) == null) return false;
	return def.applies ? def.applies(v, t) : true;
}

// ---- plain-language summary ------------------------------------------------------

export type SummaryLine = { group: string; phrases: string[] };

/**
 * What the search keeps, per group, in short phrases ("curl 0.68 ±0.05").
 * Groups with nothing kept are listed as free.
 */
export function summaryLines(
	refFor: (def: LockDef) => RefSource | null,
	states: Record<string, LockState>,
	skip: Record<string, string>
): { kept: SummaryLine[]; free: string[] } {
	const kept: SummaryLine[] = [];
	const free: string[] = [];
	for (const g of GROUPS) {
		const phrases: string[] = [];
		for (const d of LOCKS) {
			if (d.group !== g.id) continue;
			const st = states[d.id];
			if (!st?.on || skip[d.id]) continue;
			const src = refFor(d);
			if (!src || !rowApplies(d, src.values, src.traits)) continue;
			const v = refValue(d, src.values);
			if (v == null) continue;
			const val = d.kind === 'grid' ? '' : formatRef(d, v);
			let tol = '';
			if (hasTol(d) && st.tol > 0) {
				tol =
					d.tolMode === 'rel' ? ` ±${Math.round(st.tol * 100)}%` : ` ±${fix(st.tol)}${d.unit ?? ''}`;
			}
			if (d.kind === 'mirror' && st.tol >= 0.5) tol = ' or mirrored';
			const name = d.short ?? d.label.toLowerCase();
			phrases.push([name, val].filter(Boolean).join(' ') + tol);
		}
		if (phrases.length > 0) kept.push({ group: g.title, phrases });
		else free.push(g.title.toLowerCase());
	}
	return { kept, free };
}

/** Color traits to set when colors are (not) kept. */
export const COLOR_TRAITS: (keyof TraitChoices)[] = ['colorPalette', 'colorMode', 'colorVariety'];

/** Address embedded in a seed (first 20 bytes), lower-case with 0x. */
export function seedAddress(seed: string): string {
	return `0x${seed.replace(/^0x/, '').slice(0, 40).toLowerCase()}`;
}

// ---- saved recipes ------------------------------------------------------------------

export type Recipe = {
	name: string;
	aspect: Aspect;
	closeness: Closeness;
	states: Record<string, LockState>;
};
const RECIPES_KEY = 'qql-studio.family-recipes.v1';
export function loadRecipes(): Recipe[] {
	try {
		const raw = localStorage.getItem(RECIPES_KEY);
		const list = raw ? JSON.parse(raw) : [];
		return Array.isArray(list) ? list : [];
	} catch {
		return [];
	}
}
export function saveRecipes(list: Recipe[]) {
	try {
		localStorage.setItem(RECIPES_KEY, JSON.stringify(list));
	} catch {}
}

// ---- time estimates -------------------------------------------------------------------

/** "1 in 3,400" style. */
export function oneIn(rate: number): string {
	if (!(rate > 0)) return 'none seen';
	const n = 1 / rate;
	if (n < 10) return `1 in ${n.toFixed(1)}`;
	if (n < 1e6) return `1 in ${Math.round(n).toLocaleString()}`;
	if (n < 1e9) return `1 in ${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} million`;
	return `1 in ${(n / 1e9).toFixed(1)} billion`;
}
/** "12 s", "4 min", "3 h", "2 days". */
export function duration(seconds: number): string {
	if (!Number.isFinite(seconds)) return '—';
	if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
	if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
	if (seconds < 48 * 3600) return `${(seconds / 3600).toFixed(seconds < 10 * 3600 ? 1 : 0)} h`;
	return `${Math.round(seconds / 86400)} days`;
}
/** Cost factor of one row, from its pass rate: "×12", or "free". */
export function costFactor(passed: number, total: number): string {
	if (total === 0) return '';
	if (passed === 0) return `×>${total.toLocaleString()}`;
	const f = total / passed;
	if (f < 1.05) return 'free';
	return f < 10 ? `×${f.toFixed(1)}` : `×${Math.round(f).toLocaleString()}`;
}

/** Stage names, matching family.rs STAGE_* and GenerateProgress.stageRejects. */
export const STAGE_NAMES = [
	'traits',
	'flow',
	'spacing & colors',
	'structure settings',
	'structure',
	'main colors',
	'result (layout)'
];
