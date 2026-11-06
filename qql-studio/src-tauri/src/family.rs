//! "Find family": search for seeds that keep chosen properties close to a
//! reference seed.
//!
//! Deliberately free of Tauri so it can be unit tested on its own. Every property is identified by a short key (e.g.
//! `"flowCenterX"`); the same functions compute a key's value for the
//! reference seed (shown in the panel) and for candidates (checked during the
//! search), so the two can never disagree.
//!
//! Properties become known at different points of the algorithm (see
//! [`key_stage`]). The search checks each condition at the earliest point its
//! property is known and drops a seed at the first failure, so most seeds cost
//! microseconds and only survivors pay for a full layout.

use qql::art::{
    FlowFieldSpec, LayoutLimits, LayoutSummary, Plan, PlanStage, RadiusBuckets, RenderData,
    SizeProfile,
};
use qql::color::{ColorDb, ColorKey};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Pipeline stages, in the order the algorithm fixes them. Index 0 is the
/// trait check done before any planning.
pub const STAGE_TRAITS: usize = 0;
pub const STAGE_FLOW: usize = 1;
pub const STAGE_COLOR: usize = 2;
pub const STAGE_STRUCT_PARAMS: usize = 3;
pub const STAGE_STRUCT_RESULT: usize = 4;
pub const STAGE_START_COLORS: usize = 5;
pub const STAGE_LAYOUT: usize = 6;
pub const NUM_STAGES: usize = 7;

/// Virtual canvas width used by the renderer (circle sizes, spacing).
const VIRTUAL_W: f64 = 2000.0;

/// Numeric keys, in display order. See [`View::num`] for units.
pub const NUM_KEYS: &[&str] = &[
    "flowAngle",
    "flowCircularity",
    "flowCenterX",
    "flowCenterY",
    "turbCount",
    "turbStrength",
    "spot1X",
    "spot1Y",
    "spot1Strength",
    "spot2X",
    "spot2Y",
    "spot2Strength",
    "ignoreOdds",
    "spacingMult",
    "spacingConst",
    "colorChangeGroup",
    "colorChangeLine",
    "scaleStart",
    "primaryColors",
    "splatterOdds",
    "splatterX",
    "splatterY",
    "ringDensity",
    "formH",
    "formV",
    "formStep",
    "formSkip",
    "formChunks",
    "orbBands",
    "orbCx",
    "orbCy",
    "orbStep",
    "orbThickness",
    "orbOffset",
    "shTarget",
    "shActual",
    "shSquare",
    "curveLength",
    "points",
    "colorsUsed",
    "small",
    "medium",
    "large",
    "areaSmall",
    "areaMedium",
    "areaLarge",
    "maxRadius",
    "coverage",
];

/// Text keys.
pub const TEXT_KEYS: &[&str] = &[
    "flowKind",
    "flowDirection",
    "flowRotation",
    "background",
    "startPrimary",
    "startSecondary",
];

/// Color-set keys (each value is a sorted list of distinct color names).
pub const SET_KEYS: &[&str] = &["primarySeq", "splatterColors", "colorsUsedSet"];

/// The stage at which a property becomes known.
pub fn key_stage(key: &str) -> usize {
    match key {
        "flowAngle" | "flowCircularity" | "flowCenterX" | "flowCenterY" | "flowKind"
        | "flowDirection" | "flowRotation" | "turbCount" | "turbStrength" | "spot1X" | "spot1Y"
        | "spot1Strength" | "spot2X" | "spot2Y" | "spot2Strength" => STAGE_FLOW,
        "ignoreOdds" | "spacingMult" | "spacingConst" | "colorChangeGroup" | "colorChangeLine"
        | "scaleStart" | "primaryColors" | "splatterOdds" | "splatterX" | "splatterY"
        | "ringDensity" | "background" | "primarySeq" | "splatterColors" => STAGE_COLOR,
        "formH" | "formV" | "formStep" | "formSkip" | "orbCx" | "orbCy" | "orbStep"
        | "orbThickness" | "orbOffset" | "shTarget" | "shSquare" => STAGE_STRUCT_PARAMS,
        "formChunks" | "orbBands" | "shActual" | "curveLength" => STAGE_STRUCT_RESULT,
        "startPrimary" | "startSecondary" => STAGE_START_COLORS,
        // Point counts, sizes, colors actually used and the density map, and
        // anything unknown: only after the full layout.
        _ => STAGE_LAYOUT,
    }
}

/// Map a planning checkpoint to the last stage whose properties it knows.
pub fn plan_stage_index(stage: PlanStage) -> usize {
    match stage {
        PlanStage::PreStructure => STAGE_COLOR,
        PlanStage::StructureParams => STAGE_STRUCT_PARAMS,
        PlanStage::Complete => STAGE_STRUCT_RESULT,
        PlanStage::StartColors => STAGE_START_COLORS,
    }
}

/// Fold a linear flow angle (radians) to the visible orientation in degrees,
/// [0, 90]: QQL's up/down and left/right flips don't change how lines look.
pub fn fold_linear_angle_deg(theta: f64) -> f64 {
    let pi = std::f64::consts::PI;
    let mut t = theta.rem_euclid(pi);
    if t > pi / 2.0 {
        t = pi - t;
    }
    t.to_degrees()
}

/// What a finished layout adds to the plan: point counts, sizes, colors
/// used and the density map. Available from a layout-only pass and from a
/// full render alike.
#[derive(Clone, Copy)]
pub struct LayoutFacts<'a> {
    pub num_points: usize,
    pub colors_used: &'a [ColorKey],
    pub radius_buckets: RadiusBuckets,
    pub size_profile: SizeProfile,
    pub density_grid: [f64; 9],
}

impl<'a> LayoutFacts<'a> {
    pub fn from_summary(l: &'a LayoutSummary) -> Self {
        Self {
            num_points: l.num_points,
            colors_used: l.colors_used.as_slice(),
            radius_buckets: l.radius_buckets,
            size_profile: l.size_profile,
            density_grid: l.density_grid,
        }
    }

    pub fn from_render(r: &'a RenderData) -> Self {
        Self {
            num_points: r.num_points,
            colors_used: r.layout_colors_used.as_slice(),
            radius_buckets: r.radius_buckets,
            size_profile: r.size_profile,
            density_grid: r.density_grid,
        }
    }
}

/// A seed's planning pass, optionally with its full layout, plus the color
/// database for names.
pub struct View<'a> {
    pub plan: &'a Plan,
    pub layout: Option<LayoutFacts<'a>>,
    pub db: &'a ColorDb,
}

fn color_name(db: &ColorDb, key: ColorKey) -> String {
    db.color(key)
        .map(|c| c.name.clone())
        .unwrap_or_else(|| format!("color#{key}"))
}

impl<'a> View<'a> {
    /// A numeric property, or `None` if the seed doesn't have it (e.g. a flow
    /// angle on a radial flow) or it isn't known yet.
    ///
    /// Units: angles in degrees; positions as fractions of canvas width /
    /// height; sizes, spacing and areas in percent; odds as probabilities.
    pub fn num(&self, key: &str) -> Option<f64> {
        let p = self.plan;
        let f = p.formation_dims.as_ref();
        let o = p.orbital_info.as_ref();
        let s = p.shadows_info.as_ref();
        let spot = |i: usize| p.top_spots.get(i);
        Some(match key {
            "flowAngle" => match p.flow_field_spec {
                FlowFieldSpec::Linear { default_theta } => fold_linear_angle_deg(default_theta),
                FlowFieldSpec::Radial { .. } => return None,
            },
            "flowCircularity" => match p.flow_field_spec {
                FlowFieldSpec::Radial { circularity, .. } => circularity,
                FlowFieldSpec::Linear { .. } => return None,
            },
            "flowCenterX" => p.radial_center?.0,
            "flowCenterY" => p.radial_center?.1,
            "turbCount" => p.num_disturbances as f64,
            "turbStrength" => p.turbulence_theta.to_degrees(),
            "spot1X" => spot(0)?.0,
            "spot1Y" => spot(0)?.1,
            "spot1Strength" => spot(0)?.2,
            "spot2X" => spot(1)?.0,
            "spot2Y" => spot(1)?.1,
            "spot2Strength" => spot(1)?.2,
            "ignoreOdds" => p.ignore_flow_field_odds,
            "spacingMult" => p.spacing_spec.multiplier,
            "spacingConst" => p.spacing_spec.constant / VIRTUAL_W * 100.0,
            "colorChangeGroup" => p.color_change_odds.group,
            "colorChangeLine" => p.color_change_odds.line,
            "scaleStart" => p.scale_start * 100.0,
            "primaryColors" => p.num_primary_colors as f64,
            "splatterOdds" => p.splatter_odds,
            "splatterX" => p.splatter_center.0,
            "splatterY" => p.splatter_center.1,
            "ringDensity" => p.ring_density,
            "formH" => f?.horizontal_sections as f64,
            "formV" => f?.vertical_sections as f64,
            "formStep" => f?.step_frac * 100.0,
            "formSkip" => f?.skip_odds,
            "formChunks" => f?.actual_chunks as f64,
            "orbBands" => o?.ring_bands as f64,
            "orbCx" => o?.center_x_frac,
            "orbCy" => o?.center_y_frac,
            "orbStep" => o?.base_step_frac * 100.0,
            "orbThickness" => o?.radial_group_step_frac * 100.0,
            "orbOffset" => o?.split_offset_rad.to_degrees(),
            "shTarget" => s?.num_circles_target as f64,
            "shActual" => s?.actual_circles as f64,
            "shSquare" => s?.p_square,
            "curveLength" => {
                if p.curve_length == 0 {
                    return None;
                }
                p.curve_length as f64
            }
            _ => return self.layout_num(key),
        })
    }

    fn layout_num(&self, key: &str) -> Option<f64> {
        let l = self.layout?;
        Some(match key {
            "points" => l.num_points as f64,
            "colorsUsed" => l.colors_used.len() as f64,
            "small" => l.radius_buckets.small as f64,
            "medium" => l.radius_buckets.medium as f64,
            "large" => l.radius_buckets.large as f64,
            "areaSmall" => l.size_profile.area_small * 100.0,
            "areaMedium" => l.size_profile.area_medium * 100.0,
            "areaLarge" => l.size_profile.area_large * 100.0,
            "maxRadius" => l.size_profile.max_radius * 100.0,
            "coverage" => l.density_grid.iter().sum::<f64>() / 9.0 * 100.0,
            _ => return None,
        })
    }

    pub fn text(&self, key: &str) -> Option<String> {
        let p = self.plan;
        Some(match key {
            "flowKind" => match p.flow_field_spec {
                FlowFieldSpec::Linear { .. } => "linear".into(),
                FlowFieldSpec::Radial { .. } => "radial".into(),
            },
            "flowDirection" => match p.flow_field_spec {
                FlowFieldSpec::Radial { direction, .. } => match direction {
                    qql::art::Direction::In => "in".into(),
                    qql::art::Direction::Out => "out".into(),
                },
                FlowFieldSpec::Linear { .. } => return None,
            },
            "flowRotation" => match p.flow_field_spec {
                FlowFieldSpec::Radial { rotation, .. } => match rotation {
                    qql::art::Rotation::Ccw => "ccw".into(),
                    qql::art::Rotation::Cw => "cw".into(),
                },
                FlowFieldSpec::Linear { .. } => return None,
            },
            "background" => color_name(self.db, p.background_color),
            "startPrimary" => color_name(self.db, p.start_colors?.0),
            "startSecondary" => color_name(self.db, p.start_colors?.1),
            _ => return None,
        })
    }

    pub fn set(&self, key: &str) -> Option<Vec<String>> {
        let keys: Vec<ColorKey> = match key {
            "primarySeq" => self.plan.primary_seq.clone(),
            "splatterColors" => self.plan.splatter_colors.clone(),
            "colorsUsedSet" => self.layout?.colors_used.to_vec(),
            _ => return None,
        };
        let mut names: Vec<String> = keys.into_iter().map(|k| color_name(self.db, k)).collect();
        names.sort();
        names.dedup();
        Some(names)
    }

    /// The 3×3 circle-coverage grid, in percent, row by row from top left.
    pub fn grid(&self) -> Option<Vec<f64>> {
        Some(
            self.layout?
                .density_grid
                .iter()
                .map(|v| v * 100.0)
                .collect(),
        )
    }

    /// Every known property, for display and for building conditions.
    pub fn values(&self) -> FamilyValues {
        let mut nums = BTreeMap::new();
        for k in NUM_KEYS {
            if let Some(v) = self.num(k) {
                nums.insert((*k).to_string(), v);
            }
        }
        let mut texts = BTreeMap::new();
        for k in TEXT_KEYS {
            if let Some(v) = self.text(k) {
                texts.insert((*k).to_string(), v);
            }
        }
        let mut sets = BTreeMap::new();
        for k in SET_KEYS {
            if let Some(v) = self.set(k) {
                sets.insert((*k).to_string(), v);
            }
        }
        FamilyValues {
            nums,
            texts,
            sets,
            grid: self.grid(),
        }
    }
}

/// All family properties of one seed, sent to the panel.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FamilyValues {
    pub nums: BTreeMap<String, f64>,
    pub texts: BTreeMap<String, String>,
    pub sets: BTreeMap<String, Vec<String>>,
    pub grid: Option<Vec<f64>>,
}

/// One condition from the Family panel.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FamilyConstraint {
    /// A numeric property must lie in `[min, max]`.
    Range { key: String, min: f64, max: f64 },
    /// A numeric property must equal one of `values` (e.g. a value or its
    /// mirror image).
    OneOf { key: String, values: Vec<f64> },
    /// A text property must equal `value`.
    Equals { key: String, value: String },
    /// The point (`kx`, `ky`) must lie within `radius` of (`x`, `y`).
    Near {
        kx: String,
        ky: String,
        x: f64,
        y: f64,
        radius: f64,
    },
    /// A color set must hold exactly these colors (order and repeats ignored).
    SameSet { key: String, values: Vec<String> },
    /// Each cell of the density grid must be within `tol` (percentage points)
    /// of `values`.
    GridNear { values: Vec<f64>, tol: f64 },
}

impl FamilyConstraint {
    /// The stage at which every property this condition reads is known.
    pub fn stage(&self) -> usize {
        match self {
            FamilyConstraint::Range { key, .. }
            | FamilyConstraint::OneOf { key, .. }
            | FamilyConstraint::Equals { key, .. }
            | FamilyConstraint::SameSet { key, .. } => key_stage(key),
            FamilyConstraint::Near { kx, ky, .. } => key_stage(kx).max(key_stage(ky)),
            FamilyConstraint::GridNear { .. } => STAGE_LAYOUT,
        }
    }

    pub fn needs_layout(&self) -> bool {
        self.stage() == STAGE_LAYOUT
    }

    /// Whether a seed satisfies this condition. A property the seed doesn't
    /// have (e.g. a flow angle on a radial flow) never matches.
    pub fn passes(&self, v: &View) -> bool {
        match self {
            FamilyConstraint::Range { key, min, max } => {
                v.num(key).is_some_and(|x| x >= *min && x <= *max)
            }
            FamilyConstraint::OneOf { key, values } => v.num(key).is_some_and(|x| {
                values
                    .iter()
                    .any(|w| (x - w).abs() <= 1e-6 * w.abs().max(1.0))
            }),
            FamilyConstraint::Equals { key, value } => v.text(key).is_some_and(|t| t == *value),
            FamilyConstraint::Near {
                kx,
                ky,
                x,
                y,
                radius,
            } => match (v.num(kx), v.num(ky)) {
                (Some(a), Some(b)) => ((a - x).powi(2) + (b - y).powi(2)).sqrt() <= *radius,
                _ => false,
            },
            FamilyConstraint::SameSet { key, values } => v.set(key).is_some_and(|got| {
                let mut want = values.clone();
                want.sort();
                want.dedup();
                got == want
            }),
            FamilyConstraint::GridNear { values, tol } => v.grid().is_some_and(|g| {
                g.len() == values.len() && g.iter().zip(values).all(|(a, b)| (a - b).abs() <= *tol)
            }),
        }
    }
}

/// Family conditions grouped by stage, so each checkpoint only evaluates the
/// conditions it can.
pub struct StagedFamily<'a> {
    by_stage: [Vec<&'a FamilyConstraint>; NUM_STAGES],
}

impl<'a> StagedFamily<'a> {
    pub fn new(all: &'a [FamilyConstraint]) -> Self {
        let mut by_stage: [Vec<&'a FamilyConstraint>; NUM_STAGES] = Default::default();
        for c in all {
            by_stage[c.stage()].push(c);
        }
        Self { by_stage }
    }

    /// Whether any condition is checked before the layout.
    pub fn any_plan(&self) -> bool {
        (STAGE_FLOW..STAGE_LAYOUT).any(|s| !self.by_stage[s].is_empty())
    }

    pub fn any_layout(&self) -> bool {
        !self.by_stage[STAGE_LAYOUT].is_empty()
    }

    /// Check one stage; returns false if any condition of that stage fails.
    pub fn check(&self, stage: usize, v: &View) -> bool {
        self.by_stage[stage].iter().all(|c| c.passes(v))
    }

    /// The planning stages up to and including `upto` that haven't been
    /// checked yet, starting after `done`. Returns the first failing stage.
    fn first_failure(&self, done: usize, upto: usize, v: &View) -> Option<usize> {
        ((done + 1)..=upto).find(|&s| !self.check(s, v))
    }

    /// Run the staged planning pass for one seed, stopping at the first stage
    /// that fails. On rejection, bumps `rejects[stage]` and returns `None`.
    pub fn plan(
        &self,
        seed: &[u8; 32],
        db: &ColorDb,
        rejects: &[AtomicUsize; NUM_STAGES],
    ) -> Option<Plan> {
        let mut done = STAGE_TRAITS;
        qql::art::plan_staged(seed, db, |stage, p| {
            let upto = plan_stage_index(stage);
            let view = View {
                plan: p,
                layout: None,
                db,
            };
            match self.first_failure(done, upto, &view) {
                Some(s) => {
                    rejects[s].fetch_add(1, Ordering::Relaxed);
                    false
                }
                None => {
                    done = upto;
                    true
                }
            }
        })
    }
}

/// Upper bounds a layout can stop on early, from conditions on point counts,
/// circle counts and the largest circle. Only maxima can work this way:
/// counts only grow while points are placed.
pub fn layout_limits(family: &[FamilyConstraint]) -> LayoutLimits {
    fn tighten(slot: &mut Option<usize>, max: f64) {
        let m = max.max(0.0).floor() as usize;
        *slot = Some(slot.map_or(m, |s| s.min(m)));
    }
    let mut l = LayoutLimits::default();
    for c in family {
        if let FamilyConstraint::Range { key, max, .. } = c {
            if !max.is_finite() {
                continue;
            }
            match key.as_str() {
                "points" => tighten(&mut l.max_points, *max),
                "small" => tighten(&mut l.max_small, *max),
                "medium" => tighten(&mut l.max_medium, *max),
                "large" => tighten(&mut l.max_large, *max),
                "maxRadius" => {
                    // Percent of canvas width -> virtual canvas units.
                    let r = max.max(0.0) / 100.0 * VIRTUAL_W;
                    l.max_radius = Some(l.max_radius.map_or(r, |x| x.min(r)));
                }
                _ => {}
            }
        }
    }
    l
}

pub fn new_stage_counters() -> [AtomicUsize; NUM_STAGES] {
    Default::default()
}

pub fn load_stage_counters(c: &[AtomicUsize; NUM_STAGES]) -> Vec<usize> {
    c.iter().map(|a| a.load(Ordering::Relaxed)).collect()
}

/// Pass counts for one condition (or a group of them).
#[derive(Serialize, Debug, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintRate {
    pub passed: usize,
    pub total: usize,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct EstimateOutcome {
    /// Pass counts per condition, in request order. Pre-layout conditions are
    /// measured each on their own; layout conditions on seeds that passed all
    /// pre-layout conditions (so they include the combined effect).
    pub per_constraint: Vec<ConstraintRate>,
    /// Seeds passing every pre-layout condition together.
    pub plan_all: ConstraintRate,
    /// Of those, seeds that also pass every layout condition.
    pub layout_all: ConstraintRate,
    /// Where seeds were rejected in the combined pass, per stage.
    pub stage_rejects: Vec<usize>,
    /// Average single-thread cost per candidate of the early-exit pass, and
    /// of one full layout, in milliseconds.
    pub avg_plan_ms: f64,
    pub avg_layout_ms: f64,
}

pub struct EstimateOptions {
    /// Full planning passes used for per-condition rates.
    pub samples: usize,
    /// Time budget for the early-exit pass measuring the combined rate of all
    /// pre-layout conditions.
    pub plan_budget: std::time::Duration,
    /// Time budget for full layouts of seeds that passed every pre-layout
    /// condition.
    pub layout_budget: std::time::Duration,
    /// Upper bound on candidates tried in the early-exit pass.
    pub max_tried: usize,
}

/// Estimate how often the family conditions hold, by sampling seeds from
/// `gen` (which should produce seeds the way the search would).
pub fn estimate<G>(
    cons: &[FamilyConstraint],
    db: &ColorDb,
    config: &qql::config::Config,
    pool: &rayon::ThreadPool,
    opts: &EstimateOptions,
    mut gen: G,
) -> Result<EstimateOutcome, String>
where
    G: FnMut() -> Result<[u8; 32], String>,
{
    use rayon::prelude::*;
    use std::time::Instant;

    let staged = StagedFamily::new(cons);
    let mut per = vec![ConstraintRate::default(); cons.len()];
    let workers = pool.current_num_threads().max(1);

    // 1. Per-condition rates for pre-layout conditions: full planning passes.
    if staged.any_plan() {
        let seeds = (0..opts.samples)
            .map(|_| gen())
            .collect::<Result<Vec<_>, _>>()?;
        let plans: Vec<Plan> =
            pool.install(|| seeds.par_iter().map(|s| qql::art::plan(s, db)).collect());
        for p in &plans {
            let v = View {
                plan: p,
                layout: None,
                db,
            };
            for (i, c) in cons.iter().enumerate() {
                if c.needs_layout() {
                    continue;
                }
                per[i].total += 1;
                if c.passes(&v) {
                    per[i].passed += 1;
                }
            }
        }
    }

    // 2. Combined rate of all pre-layout conditions, with early exit, until
    //    enough seeds pass or the budget runs out.
    let rejects = new_stage_counters();
    let started = Instant::now();
    let mut tried = 0usize;
    let mut cpu_ms = 0.0f64;
    let mut survivors: Vec<[u8; 32]> = Vec::new();
    let target_survivors = if staged.any_layout() { 60 } else { 30 };
    let batch = (workers * 512).max(2048);
    while started.elapsed() < opts.plan_budget
        && survivors.len() < target_survivors
        && tried < opts.max_tried
    {
        let seeds = (0..batch).map(|_| gen()).collect::<Result<Vec<_>, _>>()?;
        let results: Vec<(bool, f64)> = pool.install(|| {
            seeds
                .par_iter()
                .map(|s| {
                    let t = Instant::now();
                    let ok = staged.plan(s, db, &rejects).is_some();
                    (ok, t.elapsed().as_secs_f64() * 1000.0)
                })
                .collect()
        });
        tried += seeds.len();
        for (s, (ok, ms)) in seeds.iter().zip(&results) {
            cpu_ms += ms;
            if *ok {
                survivors.push(*s);
            }
        }
        if !staged.any_plan() {
            break; // nothing to filter early: every seed survives
        }
    }
    let avg_plan_ms = cpu_ms / tried.max(1) as f64;
    let plan_all = ConstraintRate {
        passed: survivors.len(),
        total: tried,
    };

    // 3. Layout conditions, measured on the survivors (so they include the
    //    combined effect of all earlier conditions).
    let mut layout_all = ConstraintRate::default();
    let mut avg_layout_ms = 0.0;
    if staged.any_layout() && !survivors.is_empty() {
        let started = Instant::now();
        let mut layout_ms_total = 0.0;
        let mut idx = 0usize;
        while started.elapsed() < opts.layout_budget && idx < survivors.len() {
            let end = (idx + workers).min(survivors.len());
            let batch: Vec<(Plan, LayoutSummary, f64)> = pool.install(|| {
                survivors[idx..end]
                    .par_iter()
                    .map(|s| {
                        let t = Instant::now();
                        let p = qql::art::plan(s, db);
                        let l = qql::art::layout(s, db, config);
                        (p, l, t.elapsed().as_secs_f64() * 1000.0)
                    })
                    .collect()
            });
            idx = end;
            for (p, l, ms) in &batch {
                layout_ms_total += ms;
                layout_all.total += 1;
                let v = View {
                    plan: p,
                    layout: Some(LayoutFacts::from_summary(l)),
                    db,
                };
                let mut all = true;
                for (i, c) in cons.iter().enumerate() {
                    if !c.needs_layout() {
                        continue;
                    }
                    per[i].total += 1;
                    if c.passes(&v) {
                        per[i].passed += 1;
                    } else {
                        all = false;
                    }
                }
                if all {
                    layout_all.passed += 1;
                }
            }
        }
        avg_layout_ms = layout_ms_total / layout_all.total.max(1) as f64;
        rejects[STAGE_LAYOUT].store(layout_all.total - layout_all.passed, Ordering::Relaxed);
    }

    Ok(EstimateOutcome {
        per_constraint: per,
        plan_all,
        layout_all,
        stage_rejects: load_stage_counters(&rejects),
        avg_plan_ms,
        avg_layout_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use qql::art::{layout, plan};
    use qql::config::Config;

    const SEEDS: &[&str] = &[
        "33c9371d25ce44a408f8a6473fbad86bf81e1a17a2e52c90cf66ffff1296712e",
        "4c61496e282ba45975b6863f14aeed35d686abfe78273b39ee44ffff146a6246",
        "b788f929c27e0a6e9abfc2a66ad878d73a930d128e1b0f08e009ffff10d10d4b",
        "acfa3e822961cede6dabbbeef96838fec3ad3d471757c33c6737ffff14a14aaf",
        "039cd535c7d3bcb04e93ad44491b30185ee0a4c5674d1f6be3f2ffff12256335",
    ];

    fn seed(h: &str) -> [u8; 32] {
        hex::decode(h).unwrap().try_into().unwrap()
    }

    /// Conditions built from a seed's own values must accept that seed, at
    /// every stage, whether checked staged or after the full layout.
    #[test]
    fn reference_matches_itself() {
        let db = ColorDb::from_bundle();
        let config = Config::default();
        for h in SEEDS {
            let s = seed(h);
            let p = plan(&s, &db);
            let l = layout(&s, &db, &config);
            let v = View {
                plan: &p,
                layout: Some(LayoutFacts::from_summary(&l)),
                db: &db,
            };
            let vals = v.values();
            let mut cons = Vec::new();
            for (k, x) in &vals.nums {
                cons.push(FamilyConstraint::Range {
                    key: k.clone(),
                    min: x - 1e-9,
                    max: x + 1e-9,
                });
            }
            for (k, t) in &vals.texts {
                cons.push(FamilyConstraint::Equals {
                    key: k.clone(),
                    value: t.clone(),
                });
            }
            for (k, set) in &vals.sets {
                cons.push(FamilyConstraint::SameSet {
                    key: k.clone(),
                    values: set.clone(),
                });
            }
            cons.push(FamilyConstraint::GridNear {
                values: vals.grid.clone().unwrap(),
                tol: 1e-9,
            });
            for c in &cons {
                assert!(c.passes(&v), "{h}: {c:?}");
            }
            let staged = StagedFamily::new(&cons);
            let rejects = new_stage_counters();
            let planned = staged.plan(&s, &db, &rejects);
            assert!(
                planned.is_some(),
                "{h}: staged plan rejected its own values"
            );
            assert_eq!(load_stage_counters(&rejects).iter().sum::<usize>(), 0);
        }
    }

    /// A condition that can't hold must reject at its own stage.
    #[test]
    fn rejects_at_the_right_stage() {
        let db = ColorDb::from_bundle();
        let s = seed(SEEDS[0]);
        let p = plan(&s, &db);
        let bg = View {
            plan: &p,
            layout: None,
            db: &db,
        }
        .text("background")
        .unwrap();
        let cases: Vec<(FamilyConstraint, usize)> = vec![
            (
                FamilyConstraint::Range {
                    key: "turbCount".into(),
                    min: 1000.0,
                    max: 2000.0,
                },
                STAGE_FLOW,
            ),
            (
                FamilyConstraint::Equals {
                    key: "background".into(),
                    value: format!("not {bg}"),
                },
                STAGE_COLOR,
            ),
            (
                FamilyConstraint::Range {
                    key: "curveLength".into(),
                    min: 1.0,
                    max: 2.0,
                },
                STAGE_STRUCT_RESULT,
            ),
            (
                FamilyConstraint::Equals {
                    key: "startPrimary".into(),
                    value: "no such color".into(),
                },
                STAGE_START_COLORS,
            ),
        ];
        for (c, stage) in cases {
            let cons = vec![c];
            let staged = StagedFamily::new(&cons);
            let rejects = new_stage_counters();
            assert!(staged.plan(&s, &db, &rejects).is_none());
            let counts = load_stage_counters(&rejects);
            assert_eq!(counts[stage], 1, "{:?} -> {counts:?}", cons[0]);
            assert_eq!(counts.iter().sum::<usize>(), 1);
        }
    }

    #[test]
    fn every_key_has_a_stage_and_known_keys_resolve() {
        for k in NUM_KEYS.iter().chain(TEXT_KEYS).chain(SET_KEYS) {
            assert!(key_stage(k) >= STAGE_FLOW, "{k}");
        }
        assert_eq!(key_stage("points"), STAGE_LAYOUT);
        assert_eq!(key_stage("startPrimary"), STAGE_START_COLORS);
    }

    /// The estimate must find the reference's own family when the
    /// conditions are loose, and report sane numbers.
    #[test]
    fn estimate_runs() {
        let db = ColorDb::from_bundle();
        let config = Config::default();
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(4)
            .build()
            .unwrap();
        let s = seed(SEEDS[0]);
        let p = plan(&s, &db);
        let v = View {
            plan: &p,
            layout: None,
            db: &db,
        };
        let cons = vec![
            FamilyConstraint::Equals {
                key: "flowKind".into(),
                value: v.text("flowKind").unwrap(),
            },
            FamilyConstraint::Range {
                key: "points".into(),
                min: 0.0,
                max: 1e9,
            },
        ];
        // Same traits, varying nonce.
        let mut n: u64 = 1;
        let gen = || {
            n += 1;
            let mut x = s;
            x[20..26].copy_from_slice(&n.to_be_bytes()[2..8]);
            Ok(x)
        };
        let opts = EstimateOptions {
            samples: 200,
            plan_budget: std::time::Duration::from_secs(2),
            layout_budget: std::time::Duration::from_secs(5),
            max_tried: 100_000,
        };
        let out = estimate(&cons, &db, &config, &pool, &opts, gen).unwrap();
        assert_eq!(out.per_constraint[0].total, 200);
        // Same traits => same flow kind, always.
        assert_eq!(out.per_constraint[0].passed, 200);
        assert!(out.plan_all.passed > 0);
        assert!(out.layout_all.total > 0);
        assert_eq!(out.layout_all.passed, out.layout_all.total);
    }

    /// Rough throughput of the early-exit pass (run with --ignored).
    #[test]
    #[ignore]
    fn bench_early_exit() {
        let db = ColorDb::from_bundle();
        let s = seed(SEEDS[1]);
        let p = plan(&s, &db);
        let v = View {
            plan: &p,
            layout: None,
            db: &db,
        };
        let cons = vec![
            FamilyConstraint::Near {
                kx: "flowCenterX".into(),
                ky: "flowCenterY".into(),
                x: v.num("flowCenterX").unwrap(),
                y: v.num("flowCenterY").unwrap(),
                radius: 0.1,
            },
            FamilyConstraint::Equals {
                key: "startPrimary".into(),
                value: v.text("startPrimary").unwrap(),
            },
        ];
        let staged = StagedFamily::new(&cons);
        let rejects = new_stage_counters();
        let t = std::time::Instant::now();
        let n = 200_000u64;
        let mut hits = 0;
        for i in 0..n {
            let mut x = s;
            x[20..26].copy_from_slice(&(i * 7919 + 13).to_be_bytes()[2..8]);
            if staged.plan(&x, &db, &rejects).is_some() {
                hits += 1;
            }
        }
        let secs = t.elapsed().as_secs_f64();
        eprintln!(
            "{n} seeds in {secs:.2}s = {:.0}/s/thread, hits {hits}, rejects {:?}",
            n as f64 / secs,
            load_stage_counters(&rejects)
        );
    }

    /// A full render must report the same family values as a layout-only
    /// pass (the detail view uses the render, the search uses layouts).
    #[test]
    fn render_and_layout_agree() {
        let db = ColorDb::from_bundle();
        let config = Config::default();
        for h in &SEEDS[..3] {
            let s = seed(h);
            let p = plan(&s, &db);
            let l = layout(&s, &db, &config);
            let r = qql::art::draw(&s, &db, &config, 200, |_| {});
            let a = View {
                plan: &p,
                layout: Some(LayoutFacts::from_summary(&l)),
                db: &db,
            }
            .values();
            let b = View {
                plan: &p,
                layout: Some(LayoutFacts::from_render(&r)),
                db: &db,
            }
            .values();
            for (k, x) in &a.nums {
                let y = b.nums.get(k).copied();
                if y != Some(*x) {
                    eprintln!("{h} {k}: layout {x} render {y:?}");
                }
            }
            assert_eq!(a.nums, b.nums, "{h}");
            assert_eq!(a.sets, b.sets, "{h}");
            assert_eq!(a.grid, b.grid, "{h}");
        }
    }

    /// The panel sends conditions in this exact JSON shape (family.ts).
    #[test]
    fn parses_panel_json() {
        let json = r#"[
            {"kind":"near","kx":"flowCenterX","ky":"flowCenterY","x":0.5,"y":0.5,"radius":0.15},
            {"kind":"equals","key":"flowDirection","value":"out"},
            {"kind":"range","key":"flowCircularity","min":0.9,"max":1.06},
            {"kind":"oneOf","key":"orbCx","values":[0.5]},
            {"kind":"sameSet","key":"splatterColors","values":["fYellow"]},
            {"kind":"gridNear","values":[1,2,3,4,5,6,7,8,9],"tol":20}
        ]"#;
        let cons: Vec<FamilyConstraint> = serde_json::from_str(json).unwrap();
        assert_eq!(cons.len(), 6);
        assert!(matches!(cons[4], FamilyConstraint::SameSet { .. }));
        assert_eq!(cons[5].stage(), STAGE_LAYOUT);
        assert_eq!(cons[4].stage(), STAGE_COLOR);
    }

    #[test]
    fn limits_from_maxima() {
        let cons = vec![
            FamilyConstraint::Range {
                key: "points".into(),
                min: 0.0,
                max: 120.7,
            },
            FamilyConstraint::Range {
                key: "maxRadius".into(),
                min: 0.0,
                max: 2.5,
            },
        ];
        let l = layout_limits(&cons);
        assert_eq!(l.max_points, Some(120));
        assert!((l.max_radius.unwrap() - 50.0).abs() < 1e-9);
    }
}
