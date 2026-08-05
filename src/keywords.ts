// Reference lists for ORCA 6.x simple-input keywords, blocks and block
// options, compiled from the official ORCA manual, chapter "General
// Structure of the Input File" (https://www.faccts.de/docs/orca/6.1/manual/
// and the mirror at https://orca-manual.mpi-muelheim.mpg.de/).
//
// IMPORTANT -- scope: ORCA's manual runs to well over a thousand pages and
// documents thousands of block-level variables spread across dozens of
// modules (%scf, %tddft, %mdci, %casscf, %eprnmr, ...). It is not
// realistic (or maintainable) to enumerate literally every keyword that
// ever appears in it. What IS covered comprehensively here is the "simple
// input" keyword line (everything you can put after "!") -- runtypes,
// wavefunction methods, DFT functionals, basis sets, auxiliary basis
// sets, ECPs, relativistic/SOC options, convergence/algorithm switches --
// because that's a closed, well-documented list and the part users type
// (and mistype) the most. For block *contents* (the stuff inside
// %block ... end), only the most common options are listed explicitly;
// everything else is still accepted without a warning as long as it's a
// plausible identifier, since flagging arbitrary block variables as
// "unknown" would produce more noise than signal.
//
// Where the manual documents a whole *family* of keywords via a
// cardinal-number placeholder (e.g. "cc-pV$n$Z" for n = D,T,Q,5,6, or
// "DKH-def2-TZVP / ZORA-def2-TZVP" prefix variants), this file lists the
// common literal members AND a regex in KNOWN_PATTERN_REGEXES so
// legitimate-but-unlisted family members don't get flagged either.

// ---------------------------------------------------------------------
// Runtypes / job control
// ---------------------------------------------------------------------
export const RUNTYPE_KEYWORDS = [
  'ENERGY', 'SP', 'OPT', 'COPT', 'ENGRAD', 'NUMGRAD', 'NUMFREQ', 'FREQ',
  'ANFREQ', 'NUMNUMFREQ', 'NUMNACME', 'MD', 'CIM', 'IRC', 'OPTTS',
  'SCANTS', 'GOAT', 'DOCKER'
];

// ---------------------------------------------------------------------
// Mass / symmetry / misc
// ---------------------------------------------------------------------
export const MISC_STRUCTURE_KEYWORDS = [
  'Mass2016', 'PAF', 'UseSym', 'UseSymmetry', 'NoUseSym', 'ANGS', 'BOHRS',
  'FRACOCC', 'NoPropFile', 'SMEAR', 'NOSMEAR', 'KEEPINTS', 'NOKEEPINTS',
  'KEEPDENS', 'NOKEEPDENS', 'KEEPTRANSDENSITY', 'READINTS', 'NOREADINTS',
  'CHEAPINTS', 'NOCHEAPINTS', 'FLOAT', 'DOUBLE', 'UCFLOAT', 'CFLOAT',
  'UCDOUBLE', 'CDOUBLE'
];

// ---------------------------------------------------------------------
// Wavefunction-based methods: HF, MP2 family, high-level single
// reference (MDCI), AUTOCI, DLPNO, EOM/excited-state CC, CASSCF/NEVPT2/
// CASPT2, (uncontracted and internally-contracted) multireference CI,
// semiempirical.
// ---------------------------------------------------------------------
export const WAVEFUNCTION_METHOD_KEYWORDS = [
  'HF', 'DFT', 'FOD',
  'MP2', 'MP2RI', 'RI-MP2', 'SCS-MP2', 'RI-SCS-MP2', 'SCS-RI-MP2',
  'OO-RI-MP2', 'OO-RI-SCS-MP2', 'MP2-F12', 'F12-MP2', 'MP2-F12-RI',
  'MP2-F12D-RI', 'F12-RIMP2', 'RI-MP2-F12', 'MP3', 'SCS-MP3',
  'CCSD', 'CCSD(T)', 'CCSD-F12', 'CCSD(T)-F12', 'CCSD-F12/RI',
  'CCSD-F12D/RI', 'CCSD(T)-F12/RI', 'CCSD(T)-F12D/RI', 'QCISD',
  'QCISD(T)', 'QCISD-F12', 'QCISD(T)-F12', 'QCISD-F12/RI',
  'QCISD(T)-F12/RI', 'NCPF/1', 'CEPA/1', 'NCEPA/1', 'RI-CEPA/1-F12',
  'AUTOCI-CID', 'AUTOCI-CISD', 'AUTOCI-CISDT', 'AUTOCI-CEPA(0)',
  'AUTOCI-CCD', 'AUTOCI-CCSD', 'AUTOCI-CCSDT', 'AUTOCI-CCSDT-1',
  'AUTOCI-CCSDT-2', 'AUTOCI-CCSDT-3', 'AUTOCI-CCSDT-4', 'AUTOCI-QCISD',
  'AUTOCI-CC2', 'AUTOCI-CC3', 'AUTOCI-CCSD(T)', 'AUTOCI-CCSD[T]',
  'AUTOCI-MP2', 'AUTOCI-MP3', 'AUTOCI-MP4(SDQ)', 'AUTOCI-MP4',
  'AUTOCI-MP5',
  'DLPNO-CCSD', 'DLPNO-CCSD(T)', 'DLPNO-CCSD(T1)', 'DLPNO-MP2',
  'DLPNO-SCS-MP2', 'SCS-DLPNO-MP2', 'DLPNO-MP2-F12', 'DLPNO-MP2-F12/D',
  'DLPNO-CCSD-F12', 'DLPNO-CCSD-F12/D', 'DLPNO-CCSD(T)-F12',
  'DLPNO-CCSD(T)-F12/D', 'DLPNO-CCSD(T1)-F12', 'DLPNO-CCSD(T1)-F12/D',
  'DLPNO-NEVPT2', 'LoosePNO', 'NormalPNO', 'TightPNO', 'DLPNO-HFC1',
  'DLPNO-HFC2',
  'EOM-CCSD', 'bt-PNO-EOM-CCSD', 'STEOM-CCSD', 'bt-PNO-STEOM-CCSD',
  'STEOM-DLPNO-CCSD', 'IH-FSMR-CCSD', 'bt-PNO-IH-FSMR-CCSD',
  'DMRG', 'NEVPT2', 'SC-NEVPT2', 'RI-NEVPT2', 'FIC-NEVPT2', 'CASPT2',
  'RI-CASPT2', 'DCD-CAS(2)', 'RI-DCD-CAS(2)',
  'FIC-MRCI', 'FIC-DDCI3', 'FIC-DDCI3-C0', 'FIC-CEPA(0)', 'FIC-ACPF',
  'FIC-AQCC', 'FIC-MRCC',
  'MRCI', 'MRCI+Q', 'MRACPF', 'MRAQCC', 'MRDDCI1', 'MRDDCI2', 'MRDDCI3',
  'SORCI', 'RI-MRCI',
  'FROZENCORE', 'NOFROZENCORE',
  'ZINDO/S', 'ZINDO/1', 'ZINDO/2', 'NDDO/1', 'NDDO/2', 'MNDO', 'AM1',
  'PM3', 'XTB', 'XTB1', 'XTB2', 'GFN2-XTB',
  'CIS', 'TD-DFT', 'TDDFT', 'RPA', 'ROCIS'
];

// ---------------------------------------------------------------------
// Algorithmic switches: SCF type, RI variants, guess, convergence
// thresholds/acceleration/strategy, output control, grid, basis
// decontraction.
// ---------------------------------------------------------------------
export const ALGORITHMIC_KEYWORDS = [
  'RHF', 'RKS', 'UHF', 'UKS', 'ROHF', 'ROKS', 'AllowRHF', 'RI', 'NORI',
  'RIJCOSX', 'RI-JK', 'SPLITJ', 'SPLIT-RI-J', 'NoSplit-RI-J', 'RI-J-XC',
  'DIRECT', 'CONV', 'NOITER', 'NOCOSX',
  'PATOM', 'PMODEL', 'HUECKEL', 'HCORE', 'MOREAD', 'AUTOSTART',
  'NOAUTOSTART',
  'DecontractBas', 'NoDecontractBas', 'DecontractAuxJ', 'NoDecontractAuxJ',
  'DecontractAuxJK', 'NoDecontractAuxJK', 'DecontractAuxC',
  'NoDecontractAuxC', 'Decontract',
  'DEFGRID1', 'DEFGRID2', 'DEFGRID3', 'NOFINALGRIDX',
  'NORMALSCF', 'LOOSESCF', 'SLOPPYSCF', 'STRONGSCF', 'TIGHTSCF',
  'VERYTIGHTSCF', 'EXTREMESCF', 'VERYTIGHTOPT', 'TIGHTOPT', 'NORMALOPT',
  'LOOSEOPT',
  'DIIS', 'NODIIS', 'KDIIS', 'TRAH', 'NOTRAH', 'SOSCF', 'NOSOSCF',
  'DAMP', 'NODAMP', 'LSHIFT', 'NOLSHIFT',
  'EasyConv', 'NormalConv', 'SlowConv', 'VerySlowConv',
  'NORMALPRINT', 'MINIPRINT', 'SMALLPRINT', 'LARGEPRINT', 'PRINTMOS',
  'NOPRINTMOS', 'PRINTBASIS', 'PRINTGAP', 'ALLPOP', 'NOPOP', 'MULLIKEN',
  'NOMULLIKEN', 'LOEWDIN', 'NOLOEWDIN', 'MAYER', 'NOMAYER', 'NPA', 'NBO',
  'NONPA', 'NONBO', 'REDUCEDPOP', 'NOREDUCEDPOP', 'UNO', 'AIM', 'XYZFILE',
  'PDBFILE'
];

// ---------------------------------------------------------------------
// Relativistic Hamiltonians & spin-orbit coupling
// ---------------------------------------------------------------------
export const RELATIVISTIC_KEYWORDS = [
  'DKH', 'DKH2', 'ZORA', 'X2C', 'DLU-X2C',
  'SOMF(1X)', 'RI-SOMF(1X)', 'SOMF(4X)', 'RI-SOMF(4X)', 'SOMF(4XS)',
  'RI-SOMF(4XS)', 'VEFF-SOC', 'VEFF(-2X)-SOC', 'AMFI', 'ZEFF-SOC'
];

// ---------------------------------------------------------------------
// Nudged Elastic Band job types
// ---------------------------------------------------------------------
export const NEB_KEYWORDS = [
  'NEB', 'ZOOM-NEB', 'NEB-IDPP', 'NEB-CI', 'ZOOM-NEB-CI', 'NEB-MMFTS',
  'NEB-TS', 'ZOOM-NEB-TS', 'FLAT-NEB-TS', 'FAST-NEB-TS', 'LOOSE-NEB-TS',
  'TIGHT-NEB-TS'
];

// ---------------------------------------------------------------------
// DFT exchange-correlation functionals (local/GGA, hybrid, meta-GGA,
// range-separated, double-hybrid and their SCS/SOS/range-separated
// variants, plus composite methods).
// ---------------------------------------------------------------------
export const DFT_FUNCTIONAL_KEYWORDS = [
  'HFS', 'LDA', 'LSD', 'VWN', 'VWN5', 'VWN3', 'PWLDA', 'BP86', 'BP',
  'BLYP', 'OLYP', 'GLYP', 'XLYP', 'PW91', 'mPWPW', 'mPWLYP', 'PBE',
  'RPBE', 'REVPBE', 'RPW86PBE', 'PWP',
  'B1LYP', 'B3LYP', 'B3LYP/G', 'O3LYP', 'X3LYP', 'B1P', 'B3P', 'B3PW',
  'PW1PW', 'mPW1PW', 'mPW1LYP', 'PBE0', 'REVPBE0', 'REVPBE38',
  'BHANDHLYP',
  'TPSS', 'TPSSh', 'TPSS0', 'M06L', 'M06', 'M06-2X', 'M062X', 'PW6B95',
  'B97M-V', 'B97M-D3BJ', 'B97M-D4', 'SCANfunc', 'r2SCAN', 'r2SCANh',
  'r2SCAN0', 'r2SCAN50',
  'wB97', 'wB97X', 'wB97X-D3', 'wB97X-D4', 'wB97X-D4rev', 'wB97X-V',
  'wB97X-D3BJ', 'wB97M-V', 'wB97M-D3BJ', 'wB97M-D4', 'wB97M-D4rev',
  'CAM-B3LYP', 'LC-BLYP', 'LC-PBE', 'wr2SCAN',
  'B2PLYP', 'mPW2PLYP', 'B2GP-PLYP', 'B2K-PLYP', 'B2T-PLYP', 'PWPB95',
  'PBE-QIDH', 'PBE0-DH', 'DSD-BLYP', 'DSD-PBEP86', 'DSD-PBEB95',
  'revDSD-PBEP86/2021', 'revDSD-PBEP86-D4/2021', 'revDOD-PBEP86/2021',
  'revDOD-PBEP86-D4/2021', 'Pr2SCAN50', 'Pr2SCAN69', 'kPr2SCAN50',
  'wB2PLYP', 'wB2GP-PLYP', 'RSX-QIDH', 'RSX-0DH', 'wB88PP86', 'wPBEPP86',
  'wB97M(2)', 'wPr2SCAN50',
  'wB97X-2', 'SCS/SOS-B2PLYP21', 'SCS-PBE-QIDH', 'SOS-PBE-QIDH',
  'SCS-B2GP-PLYP21', 'SOS-B2GP-PLYP21', 'SCS/SOS-wB2PLYP',
  'SCS-wB2GP-PLYP', 'SOS-wB2GP-PLYP', 'SCS-RSX-QIDH', 'SOS-RSX-QIDH',
  'SCS-wB88PP86', 'SOS-wB88PP86', 'SCS-wPBEPP86', 'SOS-wPBEPP86',
  'HF-3c', 'B97-3c', 'R2SCAN-3c', 'r2SCAN-3c', 'PBEh-3c', 'wB97X-3c',
  'D4', 'D3BJ', 'D3ZERO', 'D2',
  'NL', 'SCNL'
];

// ---------------------------------------------------------------------
// Orbital basis sets (representative literal members of each family --
// see KNOWN_PATTERN_REGEXES below for the cardinal-number / prefix
// families this doesn't enumerate exhaustively).
// ---------------------------------------------------------------------
export const BASIS_KEYWORDS = [
  'STO-3G', '3-21G', '3-21GSP', '4-22GSP', '6-31G', 'm6-31G', '6-311G',
  'def2-SVP', 'def2-SV(P)', 'def2-TZVP', 'def2-TZVP(-f)', 'def2-TZVPP',
  'def2-QZVP', 'def2-QZVPP',
  'def-TZVP', 'ma-def-TZVP', 'SV', 'SV(P)', 'SVP', 'TZV', 'TZV(P)',
  'TZVP', 'TZVPP', 'QZVP', 'QZVPP',
  'ma-def2-SVP', 'ma-def2-SV(P)', 'ma-def2-TZVP', 'ma-def2-TZVP(-f)',
  'ma-def2-TZVPP', 'ma-def2-QZVPP', 'def2-SVPD', 'def2-TZVPD',
  'def2-TZVPPD', 'def2-QZVPD', 'def2-QZVPPD',
  'dhf-SV(P)', 'dhf-SVP', 'dhf-TZVP', 'dhf-TZVPP', 'dhf-QZVP',
  'dhf-QZVPP',
  'x2c-SV(P)all', 'x2c-SVPall', 'x2c-TZVPall', 'x2c-TZVPPall',
  'x2c-QZVPall', 'x2c-QZVPPall',
  'SARC-DKH-TZVP', 'SARC-DKH-TZVPP', 'SARC-ZORA-TZVP', 'SARC-ZORA-TZVPP',
  'SARC2-DKH-QZVP', 'SARC2-ZORA-QZVP',
  'pc-0', 'pc-1', 'pc-2', 'pc-3', 'pc-4', 'aug-pc-1', 'aug-pc-2',
  'pcseg-0', 'pcseg-1', 'pcseg-2', 'pcseg-3', 'pcseg-4', 'aug-pcseg-1',
  'aug-pcseg-2', 'pcSseg-1', 'pcSseg-2', 'pcJ-1', 'pcJ-2',
  'cc-pVDZ', 'cc-pVTZ', 'cc-pVQZ', 'cc-pV5Z', 'cc-pV6Z', 'aug-cc-pVDZ',
  'aug-cc-pVTZ', 'aug-cc-pVQZ', 'aug-cc-pV5Z', 'aug-cc-pV6Z',
  'cc-pCVDZ', 'cc-pCVTZ', 'cc-pCVQZ', 'cc-pCV5Z', 'aug-cc-pCVDZ',
  'aug-cc-pCVTZ', 'aug-cc-pCVQZ', 'cc-pwCVDZ', 'cc-pwCVTZ', 'cc-pwCVQZ',
  'cc-pwCV5Z', 'aug-cc-pwCVDZ', 'aug-cc-pwCVTZ', 'aug-cc-pwCVQZ',
  'cc-pVDZ-DK', 'cc-pVTZ-DK', 'cc-pVQZ-DK', 'cc-pV5Z-DK',
  'aug-cc-pVDZ-DK', 'aug-cc-pVTZ-DK', 'aug-cc-pVQZ-DK',
  'cc-pVDZ-PP', 'cc-pVTZ-PP', 'cc-pVQZ-PP', 'aug-cc-pVDZ-PP',
  'aug-cc-pVTZ-PP', 'aug-cc-pVQZ-PP',
  'cc-pVDZ-F12', 'cc-pVTZ-F12', 'cc-pVQZ-F12', 'cc-pCVDZ-F12',
  'cc-pCVTZ-F12', 'cc-pVDZ-PP-F12', 'cc-pVTZ-PP-F12',
  'cc-pVDZ-F12-CABS', 'cc-pVTZ-F12-CABS', 'cc-pVQZ-F12-CABS',
  'ANO-pVDZ', 'ANO-pVTZ', 'ANO-pVQZ', 'ANO-pV5Z', 'saug-ANO-pVDZ',
  'aug-ANO-pVDZ', 'ANO-RCC-FULL', 'ANO-RCC-DZP', 'ANO-RCC-TZP',
  'ANO-RCC-QZP',
  'D95', 'D95p', 'MINI', 'MINIS', 'MIDI', 'MINIX', 'vDZP', 'Wachters+f',
  'Partridge-1', 'Partridge-2', 'Partridge-3', 'Partridge-4', 'LANL2DZ',
  'LANL2TZ', 'LANL2TZ(f)', 'LANL08', 'LANL08(f)', 'EPR-II', 'EPR-III',
  'IGLO-II', 'IGLO-III', 'aug-cc-pVTZ-J',
  '6-31G*', '6-31G**', '6-311G*', '6-311G**', '6-31+G*', '6-31++G**'
];

// ---------------------------------------------------------------------
// Auxiliary (fitting) basis sets and ECPs
// ---------------------------------------------------------------------
export const AUX_BASIS_KEYWORDS = [
  'Def/J', 'Def2/J', 'def2/J', 'SARC/J', 'x2c/J', 'Def2/JK', 'def2/JK',
  'Def2/JKsmall', 'cc-pVTZ/JK', 'cc-pVQZ/JK', 'aug-cc-pVTZ/JK',
  'Def2-SVP/C', 'Def2-TZVP/C', 'def2-TZVP/C', 'Def2-TZVPP/C',
  'Def2-QZVPP/C', 'Def2-SVPD/C', 'Def2-TZVPD/C', 'Def2-TZVPPD/C',
  'Def2-QZVPPD/C', 'cc-pVDZ/C', 'cc-pVTZ/C', 'cc-pVQZ/C',
  'aug-cc-pVDZ/C', 'aug-cc-pVTZ/C', 'aug-cc-pVQZ/C', 'cc-pwCVTZ/C',
  'aug-cc-pwCVTZ/C', 'cc-pVTZ-PP/C', 'aug-cc-pVTZ-PP/C', 'AutoAux'
];

export const ECP_KEYWORDS = [
  'def-ECP', 'def2-ECP', 'SK-MCDHF-RSC', 'HayWadt', 'dhf-ECP',
  'vDZP-ECP', 'def2-SD', 'def-SD', 'SDD', 'LANL1', 'LANL2'
];

// ---------------------------------------------------------------------
// Special-cased regexes for parametrized keyword families the manual
// documents via a placeholder (cardinal number n, DKH-/ZORA-/ma-
// prefixes, etc). Anything matching one of these is treated as known
// even if it's not spelled out literally above.
// ---------------------------------------------------------------------
export const KNOWN_PATTERN_REGEXES = [
  /^CPCM\([A-Za-z0-9_-]+\)$/i,
  /^SMD\([A-Za-z0-9_-]+\)$/i,
  /^PAL\d+$/i,
  /^SCFCONV\d+$/i,
  /^DEFGRID[1-3]$/i,
  /^Extrapolate(EP[23])?\s*\(.*\)$/i,
  /^(ma-)?(DKH|ZORA)-(def2?-)?(SVP|SV\(P\)|TZVP|TZVP\(-f\)|TZVPP|QZVP|QZVPP)$/i,
  /^old-(TZVP|TZVPP|QZVP|QZVPP|SVP)$/i,
  /^x2c-(SV\(P\)|SVP|TZVP|TZVPP|QZVP|QZVPP)all(-2c|-s)$/i,
  /^(aug-|d-aug-)?cc-p(w?C)?V[DTQ56](\+d)?Z(-DK3?|-PP|-F12(-CABS|-OptRI|-MP2fit)?|\/C|\/JK)?$/i,
  /^(apr|may|jun|jul|maug)-cc-pV\([DTQ]\+d\)Z$/i,
  /^(aug-)?(pcseg|pcSseg|pcJ|pc)-\d$/i,
  /^Sapporo-(DKH3-)?[DTQ]ZP-2012$/i,
  /^(s?aug-)?ANO-pV[DTQ56]Z$/i,
  /^SARC2?-(DKH|ZORA)-[A-Z]+$/i,
  /^(ZOOM-|FAST-|FLAT-|LOOSE-|TIGHT-)?NEB(-TS|-CI|-IDPP|-MMFTS)?$/i,
  /^AUTOCI-[A-Z0-9()[\]]+$/i,
  /^DLPNO-[A-Za-z0-9()/]+$/i,
  /^(RI-)?SOMF\(4XS?\)$/i,
  /^(RI-)?SOMF\(1X\)$/i
];

// ---------------------------------------------------------------------
// %block names (the complete list from the manual's "Input Blocks"
// table) plus documented synonyms.
// ---------------------------------------------------------------------
export const BLOCK_NAMES = [
  'autoci', 'basis', 'casresp', 'casscf', 'cipsi', 'cim', 'cis',
  'tddft',
  'coords', 'compound', 'cosmors', 'cpcm', 'elprop', 'eprnmr', 'esd',
  'freq', 'geom', 'irc', 'loc', 'mcrpa', 'md', 'mdci', 'method', 'mp2',
  'mrcc', 'mrci', 'neb', 'numgrad', 'nbo', 'output', 'pal', 'paras',
  'plots', 'rel', 'rocis', 'rr', 'scf', 'symmetry', 'sym',
  'moinp', 'base', 'maxcore'
];

export const BLOCK_OPTIONS = [
  'nprocs', 'maxiter', 'convergence', 'nroots', 'epsilon', 'dipole',
  'true', 'false', 'tight', 'Constraints', 'Calc_Hess', 'functional',
  'correlation', 'gtensor', 'atensor', 'SymThresh', 'UseSymmetry',
  'PointGroup', 'CleanUpGradient', 'SymRelaxOpt'
];

// ---------------------------------------------------------------------
// Aggregate list used by diagnostics/completion for the "! ..." line
// ---------------------------------------------------------------------
export const ALL_SIMPLE_KEYWORDS = [
  ...RUNTYPE_KEYWORDS,
  ...MISC_STRUCTURE_KEYWORDS,
  ...WAVEFUNCTION_METHOD_KEYWORDS,
  ...ALGORITHMIC_KEYWORDS,
  ...RELATIVISTIC_KEYWORDS,
  ...NEB_KEYWORDS,
  ...DFT_FUNCTIONAL_KEYWORDS,
  ...BASIS_KEYWORDS,
  ...AUX_BASIS_KEYWORDS,
  ...ECP_KEYWORDS
];

export function isKnownSimpleKeyword(token: string): boolean {
  const lower = token.toLowerCase();
  if (ALL_SIMPLE_KEYWORDS.some(k => k.toLowerCase() === lower)) {
    return true;
  }
  return KNOWN_PATTERN_REGEXES.some(r => r.test(token));
}

// ---------------------------------------------------------------------
// Hover documentation. Deliberately NOT exhaustive (see note at top of
// file) -- curated short, original one-line descriptions for the
// keywords/blocks people hit constantly. Anything not in this map still
// gets a generic category-based hover (see hover.ts) rather than
// nothing at all.
// ---------------------------------------------------------------------
export const KEYWORD_DOCS: Record<string, string> = {
  'SP': 'Single point energy calculation.',
  'ENERGY': 'Single point energy calculation (synonym of SP).',
  'OPT': 'Geometry optimization using redundant internal coordinates.',
  'COPT': 'Geometry optimization in Cartesian coordinates.',
  'OPTTS': 'Transition-state optimization.',
  'FREQ': 'Analytic frequency calculation (requires a stationary point).',
  'NUMFREQ': 'Numerical frequency calculation -- use when analytic frequencies are unavailable.',
  'ENGRAD': 'Single point energy + gradient calculation.',
  'NUMGRAD': 'Numerical gradient calculation.',
  'MD': 'Molecular dynamics simulation.',
  'IRC': 'Intrinsic reaction coordinate calculation from a transition state.',
  'GOAT': 'Global conformer/reaction search (Grimme, XTB-based by default).',
  'DOCKER': "ORCA's built-in docking module.",

  'UseSym': 'Turn on (rudimentary) molecular symmetry recognition.',
  'NoUseSym': 'Turn molecular symmetry recognition off.',
  'RIJCOSX': 'Coulomb term via RI, exchange term via seminumerical (chain-of-spheres) integration -- recommended default for hybrid DFT.',
  'RI': 'Use the RI (resolution-of-identity) approximation.',
  'NORI': 'Disable the RI approximation.',
  'NOITER': 'Set SCF iterations to 0 -- combine with MOREAD to just use provided orbitals.',
  'MOREAD': 'Read starting orbitals from a previous .gbw file (set with %moinp).',
  'AUTOSTART': 'Try to restart from an existing .gbw file of the same base name.',

  'TIGHTSCF': 'Tight SCF convergence threshold.',
  'VERYTIGHTSCF': 'Very tight SCF convergence threshold.',
  'LOOSESCF': 'Loose (fast, less strict) SCF convergence threshold.',
  'NORMALSCF': 'Default SCF convergence threshold.',
  'TIGHTOPT': 'Tight geometry optimization convergence.',
  'LOOSEOPT': 'Loose geometry optimization convergence.',
  'SlowConv': 'SCF convergence strategy tuned for difficult cases (e.g. many transition-metal complexes).',
  'VerySlowConv': 'SCF convergence strategy for very difficult convergence cases.',
  'SOSCF': 'Turn on the second-order SCF converger (often better than DIIS for closed-shell organics).',
  'DIIS': 'Turn on DIIS SCF convergence acceleration (default).',

  'D4': 'DFT-D4 dispersion correction (density dependent, with Becke-Johnson damping).',
  'D3BJ': 'DFT-D3 dispersion correction with Becke-Johnson damping.',
  'D3ZERO': 'DFT-D3 dispersion correction with zero damping.',
  'CPCM': 'Conductor-like Polarizable Continuum Model for implicit solvation -- use as CPCM(solvent).',

  'MP2': 'Second-order Moller-Plesset perturbation theory (selects HF + DoMP2).',
  'RI-MP2': 'RI-approximated MP2.',
  'CCSD': 'Coupled-cluster singles and doubles.',
  'CCSD(T)': 'CCSD with a perturbative triples correction ("gold standard" single-reference method).',
  'DLPNO-CCSD(T)': 'Domain-based local pair natural orbital CCSD(T) -- near-linear-scaling coupled cluster.',
  'NEVPT2': 'Strongly-contracted NEVPT2 on top of a CASSCF reference.',
  'CASPT2': 'Fully internally contracted CASPT2 on top of a CASSCF reference.',

  'XTB': 'Semiempirical tight-binding method (GFN-xTB family).',
  'AM1': 'Austin Model 1 semiempirical method.',
  'PM3': 'PM3 semiempirical method.',

  'def2-SVP': 'Karlsruhe valence double-zeta basis set with polarization -- fast, good for screening.',
  'def2-TZVP': 'Karlsruhe valence triple-zeta basis set with polarization -- solid general-purpose default.',
  'def2-QZVP': 'Karlsruhe valence quadruple-zeta basis set -- high accuracy, expensive.',
  'ma-def2-TZVP': 'Minimally augmented def2-TZVP -- adds diffuse functions, useful for anions.',
  'cc-pVDZ': 'Dunning correlation-consistent double-zeta basis set.',
  'cc-pVTZ': 'Dunning correlation-consistent triple-zeta basis set.',
  'def2/J': "Weigend's universal Coulomb-fitting auxiliary basis for def2 orbital basis sets.",
  'def2/JK': 'Combined Coulomb+exchange fitting auxiliary basis for def2 basis sets.',
  'AutoAux': 'Automatically construct a general-purpose auxiliary basis set.',
  'def2-ECP': 'Effective core potential automatically used with def2 basis sets for heavier elements.',

  'ZORA': 'Scalar relativistic ZORA Hamiltonian.',
  'DKH': 'Scalar relativistic Douglas-Kroll-Hess Hamiltonian (2nd order).',
  'X2C': 'Scalar relativistic exact two-component Hamiltonian.',

  'XYZFILE': 'Write the final geometry to a .xyz file.',
  'PRINTBASIS': 'Print the basis set in input format.'
};

// ---------------------------------------------------------------------
// Block-name documentation (from the manual's "Input Blocks" table,
// paraphrased).
// ---------------------------------------------------------------------
export const BLOCK_DOCS: Record<string, string> = {
  'autoci': 'Controls autogenerated correlation calculations (AUTOCI methods).',
  'basis': 'Specify/override orbital and auxiliary basis sets, including per-atom basis.',
  'casscf': 'Control CASSCF / NEVPT2 / DMRG calculations (active space, roots, ...).',
  'cim': 'Control Cluster-In-Molecule calculations.',
  'cis': 'Control CIS and TD-DFT calculations (synonym: %tddft).',
  'tddft': 'Control TD-DFT / CIS excited-state calculations (synonym: %cis).',
  'coords': 'Alternative way to specify atomic coordinates (instead of the *...* block).',
  'compound': 'Control multi-step "compound" job scripts.',
  'cpcm': 'Control the conductor-like polarizable continuum solvation model.',
  'elprop': 'Control electric property calculations (e.g. dipole moment).',
  'eprnmr': 'Control EPR and NMR property calculations.',
  'freq': 'Control (analytic/numeric) frequency calculations.',
  'geom': 'Control geometry optimization -- constraints, coordinate type, convergence.',
  'irc': 'Control intrinsic reaction coordinate calculations.',
  'loc': 'Control orbital localization (Pipek-Mezey, Foster-Boys, ...).',
  'md': 'Control molecular dynamics simulations.',
  'mdci': 'Control single-reference correlation methods (CCSD, CCSD(T), ...).',
  'method': 'Fine-tune the electronic structure method (functional, RI flags, grid, ...).',
  'mp2': 'Control MP2 calculation details.',
  'mrci': 'Control multireference CI calculations.',
  'neb': 'Control Nudged Elastic Band calculations.',
  'nbo': 'Control the interface to the (GEN)NBO analysis program.',
  'output': 'Control what gets printed / written to output files.',
  'pal': 'Control parallelization (number of MPI processes).',
  'plots': 'Control generation of orbital/density plot files (cube files, etc).',
  'rel': 'Control relativistic Hamiltonian options.',
  'rocis': 'Control restricted open-shell CIS calculations.',
  'scf': 'Control the SCF procedure -- convergence, guess, damping, iterations.',
  'symmetry': 'Control point-group symmetry recognition and use (synonym: %sym).',
  'sym': 'Control point-group symmetry recognition and use (synonym: %symmetry).',
  'moinp': 'Not a block -- a variable pointing to a .gbw file to read starting orbitals from.',
  'base': 'Not a block -- sets the base filename used for all output/scratch files.',
  'maxcore': 'Not a block -- sets per-core scratch memory (MB) for correlation modules.'
};
