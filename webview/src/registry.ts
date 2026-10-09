// The studio's tabs in navigation order. Owned by the orchestrator: tabs
// live in tabs/<id>/index.ts and never edit this file.

import type { TabId } from '../../src/studio/protocol';
import type { IconName } from './ui/icons';
import type { TabView } from './view';
import { view as spectra } from './tabs/spectra/index';
import { view as calcs } from './tabs/calcs/index';
import { view as runs } from './tabs/runs/index';
import { view as geom } from './tabs/geom/index';
import { view as inputs } from './tabs/inputs/index';
import { view as ml } from './tabs/ml/index';
import { view as report } from './tabs/report/index';

export interface TabEntry {
  id: TabId;
  title: string;
  /** Shown under the title in the tab header and as the nav tooltip. */
  subtitle: string;
  icon: IconName;
  view: TabView;
  /** Navigation group: analysis tools first, then authoring. */
  group: 'analyze' | 'create';
}

export const TABS: TabEntry[] = [
  { id: 'spectra', title: 'Spectra', subtitle: 'Overlay, compare and export absorption spectra with confidence bands', icon: 'spectra', view: spectra, group: 'analyze' },
  { id: 'calcs', title: 'Calculations', subtitle: 'Convergence and timing of every geometry in your ensembles', icon: 'calcs', view: calcs, group: 'analyze' },
  { id: 'runs', title: 'Runs', subtitle: 'Running jobs, machine load and live log tails', icon: 'runs', view: runs, group: 'analyze' },
  { id: 'geom', title: 'Geometries', subtitle: 'Distributions of bonds, angles and dihedrals across ensembles and trajectories', icon: 'geom', view: geom, group: 'analyze' },
  { id: 'inputs', title: 'Input Builder', subtitle: 'Generate ORCA and PySCF inputs from templates', icon: 'inputs', view: inputs, group: 'create' },
  { id: 'ml', title: 'Machine Learning', subtitle: 'Train and compare models on molecular representations', icon: 'ml', view: ml, group: 'create' },
  { id: 'report', title: 'Report', subtitle: 'Edit a LaTeX report with live PDF preview', icon: 'report', view: report, group: 'create' }
];
