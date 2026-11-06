<script lang="ts">
	// The Find family panel: what to keep from a reference seed,
	// how close hits must be, and what that costs.
	import FilterInfo from './FilterInfo.svelte';
	import type { Candidate, EstimateOutcome, FamilyConstraint } from './api';
	import {
		ASPECTS,
		CLOSENESS,
		GROUPS,
		LOCKS,
		STAGE_NAMES,
		costFactor,
		duration,
		formatRef,
		hasTol,
		loadRecipes,
		oneIn,
		refValue,
		rowApplies,
		saveRecipes,
		seedAddress,
		type Aspect,
		type Closeness,
		type Info,
		type LockDef,
		type LockState,
		type Recipe,
		type SummaryLine
	} from './family';

	type Built = { lockId: string; constraint: FamilyConstraint };

	type Props = {
		reference: Candidate;
		/** Optional second seed whose colors are used instead. */
		colorSource: Candidate | null;
		aspect: Aspect;
		closeness: Closeness;
		states: Record<string, LockState>;
		/** Rows that can't apply now, with the reason. */
		skipped: Record<string, string>;
		built: Built[];
		summary: { kept: SummaryLine[]; free: string[] };
		address: string;
		workers: number;
		estimate: EstimateOutcome | null;
		estimateStale: boolean;
		estimating: boolean;
		estimateError: string | null;
		onStart: (aspect: Aspect, closeness: Closeness) => void;
		onEstimate: () => void;
		onClearColorSource: () => void;
		onExit: () => void;
	};
	let {
		reference,
		colorSource,
		aspect,
		closeness,
		states = $bindable(),
		skipped,
		built,
		summary,
		address,
		workers,
		estimate,
		estimateStale,
		estimating,
		estimateError,
		onStart,
		onEstimate,
		onClearColorSource,
		onExit
	}: Props = $props();

	const short = (seed: string) => `${seed.slice(0, 8)}…${seed.slice(-6)}`;

	// Values a row copies: colors from the second seed when one is set.
	function source(def: LockDef): Candidate {
		return def.aspect === 'colors' && colorSource ? colorSource : reference;
	}

	type Row = { def: LockDef; value: string; cost: string; skip: string | undefined };
	const rowsByGroup = $derived.by(() => {
		const out: Record<string, { main: Row[]; more: Row[] }> = {};
		for (const g of GROUPS) out[g.id] = { main: [], more: [] };
		for (const def of LOCKS) {
			const src = source(def);
			const vals = src.stats?.family;
			if (!vals || !rowApplies(def, vals, src.traits)) continue;
			const v = refValue(def, vals);
			const row: Row = {
				def,
				value: v == null ? '—' : formatRef(def, v),
				cost: rowCost(def.id),
				skip: skipped[def.id]
			};
			(def.advanced ? out[def.group].more : out[def.group].main).push(row);
		}
		return out;
	});

	let openMore = $state<Record<string, boolean>>({});

	// Per-row cost from the latest estimate. A row with two conditions (main
	// colors) shows the stricter of the two.
	function rowCost(id: string): string {
		if (!estimate || estimateStale) return '';
		let worst: { passed: number; total: number } | null = null;
		built.forEach((b, i) => {
			if (b.lockId !== id) return;
			const r = estimate!.perConstraint[i];
			if (!r || r.total === 0) return;
			if (!worst || r.passed / r.total < worst.passed / worst.total) worst = r;
		});
		return worst ? costFactor((worst as { passed: number }).passed, (worst as { total: number }).total) : '';
	}

	// ---- estimate summary --------------------------------------------------------
	const rate = $derived.by(() => {
		if (!estimate || estimate.planAll.total === 0) return null;
		const plan = estimate.planAll.passed / estimate.planAll.total;
		const layout =
			estimate.layoutAll.total > 0 ? estimate.layoutAll.passed / estimate.layoutAll.total : 1;
		return plan * layout;
	});
	// Seeds per second over all workers: every seed pays the early checks,
	// survivors also pay a layout.
	const speed = $derived.by(() => {
		if (!estimate || estimate.planAll.total === 0) return null;
		const survive = estimate.planAll.passed / estimate.planAll.total;
		const ms = estimate.avgPlanMs + survive * estimate.avgLayoutMs;
		return ms > 0 ? (Math.max(1, workers) * 1000) / ms : null;
	});
	const perHit = $derived(rate && speed ? 1 / rate / speed : null);
	const funnel = $derived.by(() => {
		if (!estimate) return [];
		const total = estimate.planAll.total;
		return estimate.stageRejects
			.map((n, i) => ({ name: STAGE_NAMES[i], n, pct: total > 0 ? (100 * n) / total : 0 }))
			.filter((x) => x.n > 0);
	});

	// ---- address check -------------------------------------------------------------
	const refAddr = $derived(seedAddress(reference.seed));
	const addrOk = $derived(/^0x[0-9a-fA-F]{40}$/.test(address.trim()));
	const sameAddr = $derived(addrOk && address.trim().toLowerCase() === refAddr);

	// ---- recipes ------------------------------------------------------------------------
	let recipes = $state<Recipe[]>(loadRecipes());
	let recipeName = $state('');
	let recipePick = $state('');
	function saveRecipe() {
		const name = recipeName.trim();
		if (!name) return;
		const r: Recipe = { name, aspect, closeness, states: JSON.parse(JSON.stringify(states)) };
		recipes = [...recipes.filter((x) => x.name !== name), r];
		saveRecipes(recipes);
		recipeName = '';
		recipePick = name;
	}
	function applyRecipe() {
		const r = recipes.find((x) => x.name === recipePick);
		if (!r) return;
		onStart(r.aspect, r.closeness);
		const next: Record<string, LockState> = { ...states };
		for (const [id, st] of Object.entries(r.states)) if (next[id]) next[id] = { ...st };
		states = next;
	}
	function deleteRecipe() {
		recipes = recipes.filter((x) => x.name !== recipePick);
		saveRecipes(recipes);
		recipePick = '';
	}

	const activeCount = $derived(built.length);
</script>

{#snippet infoBody(info: Info)}
	<p><strong>What it is.</strong> {info.what}</p>
	<p><strong>What you see.</strong> {info.see}</p>
	<div class="tip"><strong>Tip.</strong> {info.tip}</div>
{/snippet}

{#snippet lockRow(row: Row)}
	{@const def = row.def}
	{@const st = states[def.id]}
	<div class="lock-row" class:off={!st?.on} class:skipped={!!row.skip && st?.on}>
		<div class="lock-top">
			<label class="lock-name">
				<input type="checkbox" bind:checked={states[def.id].on} />
				<span>{def.label}</span>
			</label>
			<FilterInfo title={def.label}>{@render infoBody(def.info)}</FilterInfo>
			{#if st?.on}
				<span
					class="cost"
					class:hot={row.cost.startsWith('×') && parseFloat(row.cost.slice(1)) >= 10}
					title="How much rarer this row alone makes a hit"
				>
					{row.skip ? '' : row.cost}
				</span>
			{:else}
				<span class="off-value" title="Reference value (row is off)">{row.skip ? '' : row.value}</span>
			{/if}
		</div>
		<div class="lock-bottom">
		<span class="ref" title="Reference value">{row.value}</span>
		<span class="tol">
			{#if st?.on && !row.skip && def.kind === 'mirror'}
				<button
					type="button"
					class="mini"
					onclick={() => (states[def.id].tol = st.tol >= 0.5 ? 0 : 1)}
				>
					{st.tol >= 0.5 ? 'mirror ok' : 'exact'}
				</button>
			{:else if st?.on && !row.skip && hasTol(def) && def.tolMode === 'rel'}
				±<input
					type="number"
					min="0"
					step="1"
					value={Math.round(st.tol * 100)}
					oninput={(e) => {
						const v = parseFloat((e.currentTarget as HTMLInputElement).value);
						if (Number.isFinite(v)) states[def.id].tol = Math.max(0, v) / 100;
					}}
				/>%
			{:else if st?.on && !row.skip && hasTol(def)}
				±<input
					type="number"
					min="0"
					step={def.tolStep ?? 0.01}
					bind:value={states[def.id].tol}
				/>{def.unit ?? ''}
			{:else if st?.on && !row.skip}
				<span class="muted">exact</span>
			{/if}
		</span>
		</div>
		{#if row.skip && st?.on}
			<em class="skip-note">skipped: {row.skip}</em>
		{/if}
	</div>
{/snippet}

<section class="group group-family">
	<div class="section-head">
		<h2>
			Find family
			<FilterInfo title="Find family">
				<p>
					A QQL is built in a fixed order: traits, then the flow, spacing and colors, then the
					structure, and finally the dots themselves. This panel copies chosen properties from the
					reference seed and searches for new seeds that share them.
				</p>
				<p>
					Every row is checked at the moment the algorithm decides it, cheapest first. A seed is
					dropped at the first row it fails, so most seeds cost microseconds and only the
					survivors get a full layout.
				</p>
				<div class="tip">
					<strong>Start simple.</strong> Pick what to keep and how close, press Estimate, then
					search. Loosen the row with the biggest × if hits are too rare.
				</div>
			</FilterInfo>
		</h2>
		<button class="ghost" onclick={onExit} title="Back to the normal filters">× close</button>
	</div>

	<div class="ref-line">
		<span class="muted">Reference</span>
		<code title={reference.seed}>{short(reference.seed)}</code>
		<span class="muted">{reference.traits.structure} · {reference.traits.flowField}</span>
	</div>
	{#if colorSource}
		<div class="ref-line">
			<span class="muted">Colors from</span>
			<code title={colorSource.seed}>{short(colorSource.seed)}</code>
			<span class="muted">{colorSource.traits.colorPalette}</span>
			<button class="mini" onclick={onClearColorSource} title="Use the reference's colors again">×</button>
		</div>
	{/if}
	<div class="addr-note" class:warn={!addrOk}>
		{#if !addrOk}
			Enter your own wallet address at the top: new seeds are made with it, and only that wallet can mint them.
		{:else if sameAddr}
			New seeds use your address — the same wallet that made the reference.
		{:else}
			New seeds use <code>{address.trim().slice(0, 8)}…</code>. Make sure that is your own wallet:
			only the address inside a seed can mint it.
		{/if}
	</div>

	<div class="step">
		<span class="step-label">1 · Keep</span>
		<div class="seg">
			{#each ASPECTS as a}
				<button class:on={aspect === a.id} title={a.hint} onclick={() => onStart(a.id, closeness)}>
					{a.label}
				</button>
			{/each}
		</div>
	</div>
	<div class="step">
		<span class="step-label">2 · How close</span>
		<div class="seg">
			{#each CLOSENESS as c}
				<button class:on={closeness === c.id} title={c.hint} onclick={() => onStart(aspect, c.id)}>
					{c.label}
				</button>
			{/each}
		</div>
	</div>
	<small class="muted">
		{ASPECTS.find((a) => a.id === aspect)?.hint} · {CLOSENESS.find((c) => c.id === closeness)?.hint}.
		Fine-tune the rows below.
	</small>

	<div class="summary">
		{#if summary.kept.length === 0}
			<span class="muted">Nothing is kept yet — every seed with these traits is a hit.</span>
		{:else}
			{#each summary.kept as line}
				<div class="sum-line"><span class="sum-group">{line.group}</span> {line.phrases.join(' · ')}</div>
			{/each}
			{#if summary.free.length > 0}
				<div class="sum-line muted"><span class="sum-group">Free</span> {summary.free.join(', ')}</div>
			{/if}
		{/if}
		<div class="summary-est">
			{#if estimating}
				Estimating…
			{:else if estimate && !estimateStale && rate !== null}
				About <strong>{oneIn(rate)}</strong>
				{#if perHit !== null}
					· roughly <strong>{duration(perHit)}</strong> per hit with {workers} workers
				{/if}
			{:else if estimate && estimateStale}
				<span class="muted">Settings changed — estimate again.</span>
			{:else}
				<span class="muted">Press Estimate to see how rare this family is.</span>
			{/if}
		</div>
	</div>
</section>

{#each GROUPS as g, gi}
	{@const rows = rowsByGroup[g.id]}
	{#if rows.main.length + rows.more.length > 0}
		<section class="group group-family-rows">
			<div class="section-head">
				<h2>
					{gi + 1}. {g.title}
					<FilterInfo title={g.title}>{@render infoBody(g.info)}</FilterInfo>
				</h2>
				<small class="cost-badge {g.costClass}">{g.cost}</small>
			</div>
			{#if g.id === 'colors' && [...rows.main, ...rows.more].some((r) => r.skip) && ![...rows.main, ...rows.more].some((r) => r.skip && states[r.def.id]?.on)}
				<small class="group-note">
					Color rows need the reference's palette in Traits. Choose <em>Colors</em> or
					<em>Both</em> above to set it automatically.
				</small>
			{/if}
			{#each rows.main as row (row.def.id)}
				{@render lockRow(row)}
			{/each}
			{#if rows.more.length > 0}
				{@const activeMore = rows.more.filter((r) => states[r.def.id]?.on).length}
				<button class="more" onclick={() => (openMore[g.id] = !openMore[g.id])}>
					{openMore[g.id] ? '▾' : '▸'} More ({rows.more.length}){activeMore > 0
						? ` · ${activeMore} on`
						: ''}
				</button>
				{#if openMore[g.id]}
					{#each rows.more as row (row.def.id)}
						{@render lockRow(row)}
					{/each}
				{/if}
			{/if}
		</section>
	{/if}
{/each}

<section class="group group-family">
	<div class="est-row">
		<button class="ghost" onclick={onEstimate} disabled={estimating || activeCount === 0 || !addrOk}>
			{estimating ? 'Estimating…' : 'Estimate'}
		</button>
		<small class="muted">samples a few thousand seeds (~10 s)</small>
	</div>
	{#if estimateError}<div class="error">{estimateError}</div>{/if}
	{#if estimate && !estimateStale && funnel.length > 0}
		<div class="funnel">
			<span class="muted">Where seeds drop out:</span>
			{#each funnel as f}
				<div class="funnel-row">
					<span>{f.name}</span>
					<div class="funnel-bar"><div style="width: {Math.min(100, f.pct)}%"></div></div>
					<span class="muted">{f.pct >= 1 ? f.pct.toFixed(0) : f.pct.toFixed(1)}%</span>
				</div>
			{/each}
		</div>
	{/if}

	<div class="recipes">
		<span class="label">Recipes <small>saved row settings</small></span>
		<div class="recipe-row">
			<select bind:value={recipePick}>
				<option value="">—</option>
				{#each recipes as r}<option value={r.name}>{r.name}</option>{/each}
			</select>
			<button class="ghost" onclick={applyRecipe} disabled={!recipePick}>Load</button>
			<button class="ghost" onclick={deleteRecipe} disabled={!recipePick}>Delete</button>
		</div>
		<div class="recipe-row">
			<input type="text" placeholder="name, e.g. spiral strict" bind:value={recipeName} />
			<button class="ghost" onclick={saveRecipe} disabled={!recipeName.trim()}>Save</button>
		</div>
	</div>
</section>

<style>
	section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	section.group {
		padding: 12px 14px 14px;
		border-radius: 8px;
		border-left: 3px solid #3cb6c4;
		background: #121b1d;
	}
	section.group-family-rows {
		background: #131313;
		border-left-color: #2f6f78;
		gap: 4px;
	}
	.section-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
	}
	.section-head h2 {
		margin: 0;
		font-size: 11px;
		text-transform: uppercase;
		color: #9ab;
		letter-spacing: 0.08em;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.muted {
		color: #777;
	}
	.label {
		display: block;
		font-size: 11px;
		text-transform: uppercase;
		color: #888;
		letter-spacing: 0.05em;
		margin-bottom: 3px;
	}
	.label small {
		text-transform: none;
		color: #666;
		letter-spacing: 0;
	}
	button {
		background: #2a2a2a;
		color: #ddd;
		border: 1px solid #3a3a3a;
		border-radius: 4px;
		padding: 4px 10px;
		cursor: pointer;
		font-size: 12px;
	}
	button:hover:not(:disabled) {
		background: #3a3a3a;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	button.ghost {
		background: transparent;
	}
	button.mini {
		padding: 0 6px;
		font-size: 11px;
	}
	input[type='number'],
	input[type='text'],
	select {
		background: #0d0d0d;
		color: #ddd;
		border: 1px solid #333;
		border-radius: 4px;
		padding: 3px 6px;
		font-size: 12px;
	}
	.ref-line {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 2px 8px;
		font-size: 12px;
	}
	.ref-line code {
		font-family: ui-monospace, monospace;
		font-size: 11px;
		color: #cde;
	}
	.addr-note {
		font-size: 11.5px;
		color: #8fc4a8;
		line-height: 1.4;
	}
	.addr-note.warn {
		color: #e0a14f;
	}
	.addr-note code {
		font-size: 11px;
	}
	.step {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.step-label {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #9ab;
	}
	.seg {
		display: flex;
	}
	.seg button {
		border-radius: 0;
		margin-left: -1px;
		padding: 4px 9px;
	}
	.seg button:first-child {
		border-radius: 4px 0 0 4px;
	}
	.seg button:last-child {
		border-radius: 0 4px 4px 0;
	}
	.seg button.on {
		background: #2f6f78;
		border-color: #3c8f9a;
		color: #effcff;
	}
	.summary {
		font-size: 12px;
		line-height: 1.45;
		background: #0d1416;
		border: 1px solid #22343a;
		border-radius: 6px;
		padding: 8px 10px;
		color: #cfe3e6;
	}
	.summary-est {
		margin-top: 6px;
		color: #e6e6e6;
	}
	.cost-badge {
		font-size: 10.5px;
		color: #666;
	}
	.cost-badge.instant {
		color: #4cb088;
	}
	.cost-badge.fast {
		color: #b0a04c;
	}
	.cost-badge.slow {
		color: #d0785c;
	}
	.lock-row {
		display: flex;
		flex-direction: column;
		gap: 1px;
		font-size: 12px;
		padding: 3px 0;
		border-bottom: 1px solid #1c1c1c;
	}
	.lock-row:last-of-type {
		border-bottom: none;
	}
	.lock-top {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.lock-top .cost,
	.lock-top .off-value {
		margin-left: auto;
	}
	.off-value {
		color: #555;
		font-size: 11px;
		max-width: 120px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.lock-bottom {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding-left: 22px;
		min-height: 20px;
	}
	.lock-row.off .lock-bottom {
		display: none;
	}
	.group-note {
		color: #b08a4c;
		font-size: 11px;
		line-height: 1.4;
	}
	.sum-line {
		margin-bottom: 3px;
	}
	.sum-group {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #7ab;
		margin-right: 4px;
	}
	.lock-row.off .ref,
	.lock-row.off .lock-name span {
		color: #666;
	}
	.lock-row.skipped .ref {
		text-decoration: line-through;
	}
	.lock-name {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		cursor: pointer;
	}
	.lock-name span {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ref {
		color: #cfe3e6;
		font-variant-numeric: tabular-nums;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.tol {
		display: flex;
		align-items: center;
		gap: 2px;
		color: #888;
		font-size: 11px;
	}
	.tol input {
		width: 54px;
	}
	.cost {
		font-size: 10.5px;
		color: #8a8;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.cost.hot {
		color: #e0a14f;
	}
	.skip-note {
		font-size: 10.5px;
		color: #b08a4c;
		padding-left: 22px;
	}
	button.more {
		align-self: flex-start;
		background: transparent;
		border: none;
		color: #7aa;
		padding: 2px 0;
		font-size: 11.5px;
	}
	.est-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.error {
		color: #d66;
		font-size: 11.5px;
	}
	.funnel {
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: 11.5px;
	}
	.funnel-row {
		display: grid;
		grid-template-columns: 110px 1fr 42px;
		align-items: center;
		gap: 6px;
	}
	.funnel-bar {
		height: 6px;
		background: #222;
		border-radius: 3px;
		overflow: hidden;
	}
	.funnel-bar div {
		height: 100%;
		background: #3c8f9a;
	}
	.recipes {
		margin-top: 6px;
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.recipe-row {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.recipe-row select,
	.recipe-row input {
		flex: 1;
		min-width: 0;
	}
	:global(.info-body .tip) {
		margin-top: 8px;
	}
</style>
