/**
 * Hardcoded literature/derived target ranges for the tracking benchmark.
 *
 * These are approximations, not ground truth — see the source comment on each
 * row.  `kind: 'none'` means "record only, no PASS/FAIL verdict" (either no
 * literature target exists, or the metric is a jitter/diagnostic proxy).
 */

export type TargetSpec =
  | { kind: 'range'; low: number; high: number }
  | { kind: 'max'; value: number }
  | { kind: 'min'; value: number }
  | { kind: 'none' };

export interface TargetRow {
  key: string;
  label: string;
  unit: string;
  spec: TargetSpec;
  source: string;
}

export const TARGETS: TargetRow[] = [
  {
    key: 'possessionsPerMin',
    label: 'Possessions / min',
    unit: '',
    spec: { kind: 'range', low: 0.9, high: 1.3 },
    source: 'StatsBomb-derived tempo, reports/task-o.md, ~93 effective minutes/match',
  },
  {
    key: 'passesPerMin',
    label: 'Passes / min',
    unit: '',
    spec: { kind: 'none' },
    source: 'No independent literature target — recorded alongside possessions/min for context',
  },
  {
    key: 'shotsPerTeamPerMin',
    label: 'Shots / team / min',
    unit: '',
    spec: { kind: 'range', low: 0.04, high: 0.09 },
    source: 'StatsBomb-derived tempo, reports/task-o.md, ~93 effective minutes/match',
  },
  {
    key: 'goalsPerMin',
    label: 'Goals / min (total)',
    unit: '',
    spec: { kind: 'range', low: 0.02, high: 0.05 },
    source: 'StatsBomb-derived tempo, reports/task-o.md, ~93 effective minutes/match',
  },
  {
    key: 'standingWalkingPct',
    label: 'Standing+walking time (<2 m/s)',
    unit: '%',
    spec: { kind: 'range', low: 40, high: 55 },
    source: 'Bradley 2009 / Di Salvo 2007 elite-match speed-zone shares',
  },
  {
    key: 'joggingPct',
    label: 'Jogging time (2-4 m/s)',
    unit: '%',
    spec: { kind: 'none' },
    source: 'Recorded for context, no isolated target in the audit',
  },
  {
    key: 'runningPct',
    label: 'Running time (4-5.5 m/s)',
    unit: '%',
    spec: { kind: 'none' },
    source: 'Recorded for context, no isolated target in the audit',
  },
  {
    key: 'sprintingPct',
    label: 'Sprinting time (>5.5 m/s)',
    unit: '%',
    spec: { kind: 'range', low: 2, high: 6 },
    source: 'Bradley 2009 / Di Salvo 2007 elite-match speed-zone shares',
  },
  {
    key: 'distance90km',
    label: 'Distance / 90-equiv (outfield)',
    unit: 'km',
    spec: { kind: 'range', low: 9, high: 13 },
    source: 'Di Salvo 2007 mean outfield distance covered, elite matches',
  },
  {
    key: 'accelP95',
    label: 'Accel p95',
    unit: 'm/s²',
    spec: { kind: 'max', value: 6 },
    source: 'Human sprint acceleration ceiling (~6 m/s² sustained) cited in the 2026-07 audit',
  },
  {
    key: 'blockHeightM',
    label: 'Block height (defending, ball mid third)',
    unit: 'm',
    spec: { kind: 'range', low: 30, high: 42 },
    source: '2026-07 audit target for defensive block compactness',
  },
  {
    key: 'blockWidthM',
    label: 'Block width (defending, ball mid third)',
    unit: 'm',
    spec: { kind: 'none' },
    source: 'Recorded alongside block height, no isolated target',
  },
  {
    key: 'lineHeightM',
    label: 'Defensive line height (own goal line, defending)',
    unit: 'm',
    spec: { kind: 'none' },
    source: 'Recorded only — checked for monotonicity vs. the lineHeight tactic slider, not an absolute target',
  },
  {
    key: 'dfMfGapM',
    label: 'DF-MF inter-line gap (defending)',
    unit: 'm',
    spec: { kind: 'max', value: 15 },
    source: '2026-07 audit target for a compact defensive shape',
  },
  {
    key: 'receptionMedianS',
    label: 'Reception-to-release median',
    unit: 's',
    spec: { kind: 'min', value: 1.0 },
    source: 'reports/task-i.md (historical release-time measurement) + audit target',
  },
  {
    key: 'receptionPctBelow05',
    label: 'Reception-to-release % < 0.5s',
    unit: '%',
    spec: { kind: 'max', value: 40 },
    source: 'reports/task-i.md: ~90% of passes released within 0.5s at HEAD; audit target for a plausible ceiling',
  },
  {
    key: 'boxOccupancy',
    label: 'Box occupancy (attacking-third possession)',
    unit: '',
    spec: { kind: 'range', low: 1.5, high: 4 },
    source: '2026-07 audit target derived from typical box-entry occupancy in elite matches',
  },
  {
    key: 'reversalsPerPlayerPerMin',
    label: 'Direction reversals (jitter proxy)',
    unit: '/player/min',
    spec: { kind: 'none' },
    source: 'No literature target — jitter/path-tortuosity proxy, record only (task spec §2 item 5)',
  },
];
