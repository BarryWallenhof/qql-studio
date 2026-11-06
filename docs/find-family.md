# Find family

**Find family** starts from any seed, lets you choose what to keep, and
searches for new seeds that share those properties. Everything else in QQL
Studio works as before.

## Using it

1. Open a seed: inspect it, or click a result. In the seed view, press **Find family**.
2. **Keep**: choose *Composition* (shape, flow, structure), *Colors*, or *Both*.
3. **How close**: choose *Wide*, *Middle* or *Close*.
4. Fine-tune individual rows. Each **ⓘ** says what the row means, what you
   see of it, and gives a tip.
5. Press **Estimate** to see how rare the family is, and which row costs the
   most (×N).
6. Press **Find N family members**. Hits appear as they are found.

While a search runs you can:

- **Pause** it, or **Stop** it.
- Switch between **Cool** and **Fast** (how many processor cores to use).
- Hear a **chime** on each hit. The window also flashes when it is in the
  background, and the hit count shows in the title.
- Find every hit in a CSV file under **Open hits folder**. The file is
  written as hits are found, so it survives closing the app.

In a hit's view:

- **Side by side** and **Flip** compare the hit with the reference.
- **More like this** makes the hit the new reference and keeps your settings.
- **Use its colors** keeps the reference's composition but takes this hit's
  colors.

**Recipes** save your row settings under a name, to reuse with other seeds.

## How it works

A QQL is built in a fixed order. Each step draws from one random stream:

| Stage | Decided here | Cost to check |
|---|---|---|
| 0 | traits (written into the seed) | free |
| 1 | flow: angle or swirl center, direction, curl, turbulence | µs |
| 2 | spacing, circle size, straight-line groups, colors, splatter | µs |
| 3 | structure settings (grid, ring center, bands, clusters) | µs |
| 4 | structure geometry, line length | ms |
| 5 | colors of the first line group | ms |
| 6 | dot placement → counts, sizes, colors used, 3×3 density map | up to 1 s |

The search replays the algorithm stage by stage. It checks every row as soon
as its value is known and drops a seed at the first failure, so most seeds
cost microseconds. Only survivors get a full layout. Layout limits (maximum
dots, largest circle) stop a layout as soon as it is certain to fail.

The values shown in the panel and the values checked during the search come
from the same Rust code (`src-tauri/src/family.rs`), so they cannot disagree.

## Changes by file

- `qqlrs-main/src/art.rs`, `layouts.rs` (marked `LOCAL MODIFICATION`):
  - a staged planning pass (`plan_staged`) that replays the algorithm's random
    draws without placing dots, now including the color sequences, splatter
    colors and focus, ring fill, the strongest turbulence spots, and the first
    group's colors;
  - layout limits (stop early when a maximum is crossed);
  - a 3×3 density map in layout and render summaries.

  The order of random draws is unchanged: the three golden pixel tests pass
  with a maximum channel difference of 0.
- `qql-studio/src-tauri/src/family.rs` (new): family properties, conditions,
  staged checking, and the estimate. Tauri-free and unit tested.
- `qql-studio/src-tauri/src/commands.rs`, `render.rs`: family search inside the
  existing continuous-worker search, pause, hits log, estimate, system info,
  and family values in layout stats.
- `qql-studio/src/lib/family.ts`, `FamilyPanel.svelte` (new), `Detail.svelte`,
  `+page.svelte`, `api.ts`: the panel, compare/mix/more-like-this, run
  controls.

**Deliberately left out:**

- Filters with little visible meaning: densest corner, circle counts (area is
  used instead), chunks or circles placed, and the number of colors in the
  sequence.
- The Stacked shadow offset. It is decided after layout and is barely visible.
- The radial start angle. It only affects straight-line groups.

## Tests

```sh
cd qqlrs-main && cargo test --release              # 33 unit + 3 golden tests
cd qql-studio/src-tauri && cargo test --lib --release
```

The family tests live in `family.rs` (self-match of every property, staged
rejects at the right stage, render vs. layout agreement, JSON shape of the
panel's conditions, estimate) and in `commands.rs`
(`family_search_finds_matching_seeds`).
