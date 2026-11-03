// three.js scene of the viewer tab: ball-and-stick / licorice / spacefill
// molecules drawn with instanced meshes (one draw call for all atoms, one
// for all half-bonds), orthographic or perspective camera with orbit
// controls, click-to-pick atoms, optional index labels, orbital isosurfaces
// (+ lobe blue, − lobe orange as in photoswitch scripts/plot_orbitals.py)
// and high-resolution PNG snapshots. Renders on demand, not every frame.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { elementColor, elementSymbol } from '../geom/molecule';

export type DrawStyle = 'ball' | 'licorice' | 'spacefill' | 'wire';

/** Covalent radii (Å, Cordero 2008) for bonds and ball sizes; 1.5 Å otherwise. */
const COVALENT: Record<string, number> = {
  H: 0.31, He: 0.28, Li: 1.28, Be: 0.96, B: 0.84, C: 0.76, N: 0.71, O: 0.66, F: 0.57, Ne: 0.58,
  Na: 1.66, Mg: 1.41, Al: 1.21, Si: 1.11, P: 1.07, S: 1.05, Cl: 1.02, Ar: 1.06,
  K: 2.03, Ca: 1.76, Sc: 1.7, Ti: 1.6, V: 1.53, Cr: 1.39, Mn: 1.39, Fe: 1.32, Co: 1.26, Ni: 1.24, Cu: 1.32, Zn: 1.22,
  Ga: 1.22, Ge: 1.2, As: 1.19, Se: 1.2, Br: 1.2, Kr: 1.16, Ru: 1.46, Rh: 1.42, Pd: 1.39, Ag: 1.45, I: 1.39, Xe: 1.4,
  Pt: 1.36, Au: 1.36, Hg: 1.32
};
/** van der Waals radii (Å, Bondi) for spacefill. */
const VDW: Record<string, number> = { H: 1.2, C: 1.7, N: 1.55, O: 1.52, F: 1.47, P: 1.8, S: 1.8, Cl: 1.75, Br: 1.85, I: 1.98, Si: 2.1, B: 1.92 };

export const covalentRadius = (s: string) => COVALENT[elementSymbol(s)] ?? 1.5;

/** Bonds (0-based pairs) where d < r_i + r_j + 0.45 Å. */
export function bondsOf(symbols: string[], xyz: ArrayLike<number>): [number, number][] {
  const n = symbols.length;
  const r = symbols.map(covalentRadius);
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = xyz[3 * i] - xyz[3 * j], dy = xyz[3 * i + 1] - xyz[3 * j + 1], dz = xyz[3 * i + 2] - xyz[3 * j + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      const lim = r[i] + r[j] + 0.45;
      if (d2 > 0.01 && d2 < lim * lim) out.push([i, j]);
    }
  }
  return out;
}

export interface MeshData {
  positions: number[];
  normals: number[];
  indices: number[];
}

export interface SceneOptions {
  style: DrawStyle;
  perspective: boolean;
  labels: boolean;
  /** Recompute bonds for every frame (reactions); off = bonds of the first frame. */
  dynamicBonds: boolean;
}

export const ISO_POS = '#2a78d6';
export const ISO_NEG = '#eb6834';

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * A theme color token as rgb(): tokens use color-mix(), which computes to
 * color(srgb …) — three.js parses neither, so let a 1×1 canvas convert it.
 */
export function cssColor(token: string, fallback: string): string {
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;visibility:hidden;background:var(${token})`;
  document.body.append(probe);
  const c = getComputedStyle(probe).backgroundColor;
  probe.remove();
  try {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const g = cv.getContext('2d');
    if (!g || !c) return fallback;
    g.fillStyle = fallback;
    g.fillStyle = c;
    g.fillRect(0, 0, 1, 1);
    const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${gg}, ${b})`;
  } catch {
    return fallback;
  }
}

/** Eigenvectors of a symmetric 3×3 matrix (columns of v), ascending eigenvalues, cyclic Jacobi. */
function eigSym3(m: number[][]): { values: number[]; vectors: THREE.Vector3[] } {
  const a = m.map(r => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    if (a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2 < 1e-18) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-14) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const idx = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return { values: idx.map(i => a[i][i]), vectors: idx.map(i => new THREE.Vector3(v[0][i], v[1][i], v[2][i])) };
}

export class MoleculeScene {
  readonly el: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private ortho: THREE.OrthographicCamera;
  private persp: THREE.PerspectiveCamera;
  private camera: THREE.Camera;
  private controls: OrbitControls;
  private light = new THREE.DirectionalLight(0xffffff, 2.2);
  private root = new THREE.Group();
  private atomMesh?: THREE.InstancedMesh;
  private bondMesh?: THREE.InstancedMesh;
  private pickMesh?: THREE.InstancedMesh;
  private isoGroup = new THREE.Group();
  private labelHost: HTMLElement;
  private symbols: string[] = [];
  private xyz = new Float32Array(0);
  private bonds: [number, number][] = [];
  private fixedBonds: [number, number][] = [];
  private picked: number[] = [];
  private radius = 5;
  private dirty = true;
  private raf = 0;
  private disposed = false;
  private resize: ResizeObserver;
  private onPick?: (index: number, additive: boolean) => void;
  private changeListeners: (() => void)[] = [];
  private suppressChange = false;
  opts: SceneOptions;
  isoOpacity = 0.75;

  constructor(opts: SceneOptions, onPick?: (index: number, additive: boolean) => void) {
    this.opts = { ...opts };
    this.onPick = onPick;
    this.el = document.createElement('div');
    this.el.className = 'viewer-canvas';
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.el.append(this.renderer.domElement);
    this.labelHost = document.createElement('div');
    this.labelHost.className = 'viewer-labels';
    this.el.append(this.labelHost);

    this.ortho = new THREE.OrthographicCamera(-5, 5, 5, -5, -1000, 1000);
    this.persp = new THREE.PerspectiveCamera(30, 1, 0.1, 2000);
    this.camera = this.ortho;
    this.ortho.position.set(0, 0, 50);
    this.persp.position.set(0, 0, 30);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.rotateSpeed = 0.9;
    this.controls.addEventListener('change', () => {
      this.invalidate();
      if (!this.suppressChange) this.changeListeners.forEach(f => f());
    });

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.5));
    this.scene.add(this.light);
    this.scene.add(this.root);
    this.root.add(this.isoGroup);

    // click (not drag) picks an atom
    let down: { x: number; y: number } | undefined;
    this.renderer.domElement.addEventListener('pointerdown', e => (down = { x: e.clientX, y: e.clientY }));
    this.renderer.domElement.addEventListener('pointerup', e => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) this.pickAt(e);
      down = undefined;
    });

    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(this.el);
    this.setBackground();
  }

  /** Called whenever the user moves the camera (to sync a second view). */
  onCameraChange(cb: () => void): void {
    this.changeListeners.push(cb);
  }

  setBackground(color?: string): void {
    this.renderer.setClearColor(new THREE.Color(color ?? cssColor('--surface-1', '#1e1e1e')));
    this.invalidate();
  }

  private layout(): void {
    const w = Math.max(50, this.el.clientWidth);
    const h = Math.max(50, this.el.clientHeight);
    this.setBackground();
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.updateFrustum();
    this.invalidate();
  }

  private updateFrustum(): void {
    const w = Math.max(50, this.el.clientWidth);
    const h = Math.max(50, this.el.clientHeight);
    const a = w / h;
    const r = this.radius * 1.15;
    this.ortho.left = -r * Math.max(1, a);
    this.ortho.right = r * Math.max(1, a);
    this.ortho.top = r / Math.min(1, a);
    this.ortho.bottom = -r / Math.min(1, a);
    this.ortho.updateProjectionMatrix();
    this.persp.aspect = a;
    this.persp.updateProjectionMatrix();
  }

  invalidate(): void {
    this.dirty = true;
    if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(() => this.draw());
  }

  private draw(): void {
    this.raf = 0;
    if (!this.dirty || this.disposed) return;
    this.dirty = false;
    // headlight: light comes from the camera
    this.light.position.copy(this.camera.position).add(tmpV.set(0.3, 0.5, 0).applyQuaternion(this.camera.quaternion).multiplyScalar(this.radius));
    this.light.target.position.copy(this.controls.target);
    this.light.target.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera);
    if (this.opts.labels) this.drawLabels();
  }

  // --------------------------------------------------------------- molecule

  /** New molecule (resets the camera when `fit`). */
  setMolecule(symbols: string[], xyz: ArrayLike<number>, fit = true): void {
    this.setBackground();
    const changed = symbols.length !== this.symbols.length || symbols.some((s, i) => s !== this.symbols[i]);
    this.symbols = symbols.slice();
    this.xyz = Float32Array.from(xyz);
    this.fixedBonds = bondsOf(this.symbols, this.xyz);
    this.bonds = this.fixedBonds;
    if (changed) this.picked = [];
    this.rebuild();
    if (fit) {
      this.orientPrincipal();
      this.fit();
    }
  }

  /** Look along the axis of least extent (flat molecules face the viewer), longest axis horizontal. */
  orientPrincipal(): void {
    const n = this.symbols.length;
    if (n < 2) return;
    const c = [0, 0, 0];
    for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) c[d] += this.xyz[3 * i + d] / n;
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) m[a][b] += (this.xyz[3 * i + a] - c[a]) * (this.xyz[3 * i + b] - c[b]);
    }
    const { vectors } = eigSym3(m);
    // tilt 25° about the long axis (elev=25 in plot_orbitals.py) so both lobes of π orbitals show
    const tilt = (25 * Math.PI) / 180;
    const n0 = vectors[0].normalize();
    const n1 = vectors[1].normalize();
    const view = n0.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(n1, Math.sin(tilt)).normalize();
    const up = n1.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(n0, -Math.sin(tilt)).normalize();
    const target = new THREE.Vector3(c[0], c[1], c[2]);
    this.controls.target.copy(target);
    this.camera.up.copy(up);
    this.camera.position.copy(target).addScaledVector(view, 50);
    this.camera.lookAt(target);
    this.controls.update();
  }

  /** New coordinates for the same atoms (trajectory frame, mode animation). */
  setCoords(xyz: ArrayLike<number>): void {
    if (xyz.length !== this.xyz.length) return;
    this.xyz.set(xyz);
    if (this.opts.dynamicBonds && this.symbols.length <= 600) {
      const nb = bondsOf(this.symbols, this.xyz);
      if (nb.length !== this.bonds.length || nb.some((b, i) => b[0] !== this.bonds[i][0] || b[1] !== this.bonds[i][1])) {
        this.bonds = nb;
        this.rebuild();
        return;
      }
    }
    this.updateInstances();
  }

  coords(): Float32Array {
    return this.xyz;
  }

  setOptions(o: Partial<SceneOptions>): void {
    const camChange = o.perspective !== undefined && o.perspective !== this.opts.perspective;
    Object.assign(this.opts, o);
    if (o.dynamicBonds === false) this.bonds = this.fixedBonds;
    if (camChange) this.switchCamera();
    if (!this.opts.labels) this.labelHost.replaceChildren();
    this.rebuild();
  }

  private switchCamera(): void {
    const from = this.camera;
    const to = this.opts.perspective ? this.persp : this.ortho;
    const dir = new THREE.Vector3().subVectors(from.position, this.controls.target).normalize();
    to.up.copy(from.up);
    const dist = this.opts.perspective ? this.radius / Math.tan((this.persp.fov * Math.PI) / 360) * 1.25 : 50;
    to.position.copy(this.controls.target).addScaledVector(dir, dist);
    to.lookAt(this.controls.target);
    this.camera = to;
    this.controls.object = to;
    this.controls.update();
    this.updateFrustum();
  }

  private atomRadius(i: number): number {
    const s = this.symbols[i];
    switch (this.opts.style) {
      case 'spacefill': return VDW[elementSymbol(s)] ?? covalentRadius(s) * 1.6;
      case 'licorice': return 0.16;
      case 'wire': return 0.06;
      default: return 0.18 + 0.28 * Math.min(covalentRadius(s), 1.6);
    }
  }

  private bondRadius(): number {
    return this.opts.style === 'licorice' ? 0.16 : this.opts.style === 'wire' ? 0.05 : 0.09;
  }

  private rebuild(): void {
    for (const m of [this.atomMesh, this.bondMesh, this.pickMesh]) {
      if (m) {
        this.root.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
        m.dispose();
      }
    }
    this.atomMesh = this.bondMesh = this.pickMesh = undefined;
    const n = this.symbols.length;
    if (!n) {
      this.invalidate();
      return;
    }
    const detail = n > 2000 ? 8 : n > 300 ? 14 : 24;
    const sphere = new THREE.SphereGeometry(1, detail, Math.round(detail * 0.75));
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.05 });
    this.atomMesh = new THREE.InstancedMesh(sphere, mat, n);
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) this.atomMesh.setColorAt(i, col.set(elementColor(this.symbols[i])));
    this.root.add(this.atomMesh);

    const showBonds = this.opts.style !== 'spacefill' && this.bonds.length > 0;
    if (showBonds) {
      const cyl = new THREE.CylinderGeometry(1, 1, 1, Math.max(6, Math.round(detail / 2)), 1, true);
      this.bondMesh = new THREE.InstancedMesh(cyl, new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.05 }), this.bonds.length * 2);
      this.bonds.forEach(([a, b], k) => {
        this.bondMesh!.setColorAt(2 * k, col.set(elementColor(this.symbols[a])));
        this.bondMesh!.setColorAt(2 * k + 1, col.set(elementColor(this.symbols[b])));
      });
      this.root.add(this.bondMesh);
    }
    if (this.picked.length) {
      const ring = new THREE.SphereGeometry(1, 20, 14);
      const pm = new THREE.MeshBasicMaterial({ color: new THREE.Color(cssColor('--accent', '#3b82f6')), transparent: true, opacity: 0.35, depthWrite: false });
      this.pickMesh = new THREE.InstancedMesh(ring, pm, this.picked.length);
      this.root.add(this.pickMesh);
    }
    this.updateInstances();
  }

  private updateInstances(): void {
    const p = this.xyz;
    if (this.atomMesh) {
      for (let i = 0; i < this.symbols.length; i++) {
        const r = this.atomRadius(i);
        tmpM.compose(tmpV.set(p[3 * i], p[3 * i + 1], p[3 * i + 2]), tmpQ.identity(), tmpS.set(r, r, r));
        this.atomMesh.setMatrixAt(i, tmpM);
      }
      this.atomMesh.instanceMatrix.needsUpdate = true;
      if (this.atomMesh.instanceColor) this.atomMesh.instanceColor.needsUpdate = true;
      this.atomMesh.computeBoundingSphere();
    }
    if (this.bondMesh) {
      const br = this.bondRadius();
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const mid = new THREE.Vector3();
      const dir = new THREE.Vector3();
      this.bonds.forEach(([i, j], k) => {
        a.set(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
        b.set(p[3 * j], p[3 * j + 1], p[3 * j + 2]);
        mid.addVectors(a, b).multiplyScalar(0.5);
        dir.subVectors(b, a);
        const len = dir.length();
        tmpQ.setFromUnitVectors(UP, dir.normalize());
        // half from a to mid, half from mid to b
        tmpM.compose(tmpV.addVectors(a, mid).multiplyScalar(0.5), tmpQ, tmpS.set(br, len / 2, br));
        this.bondMesh!.setMatrixAt(2 * k, tmpM);
        tmpM.compose(tmpV.addVectors(mid, b).multiplyScalar(0.5), tmpQ, tmpS.set(br, len / 2, br));
        this.bondMesh!.setMatrixAt(2 * k + 1, tmpM);
      });
      this.bondMesh.instanceMatrix.needsUpdate = true;
      if (this.bondMesh.instanceColor) this.bondMesh.instanceColor.needsUpdate = true;
      this.bondMesh.computeBoundingSphere();
    }
    if (this.pickMesh) {
      this.picked.forEach((i, k) => {
        const r = this.atomRadius(i) * 1.45 + 0.12;
        tmpM.compose(tmpV.set(p[3 * i], p[3 * i + 1], p[3 * i + 2]), tmpQ.identity(), tmpS.set(r, r, r));
        this.pickMesh!.setMatrixAt(k, tmpM);
      });
      this.pickMesh.instanceMatrix.needsUpdate = true;
      this.pickMesh.computeBoundingSphere();
    }
    this.invalidate();
  }

  /** Center the camera on the molecule (and isosurfaces) and zoom to fit. */
  fit(): void {
    const n = this.symbols.length;
    if (!n) return;
    const c = new THREE.Vector3();
    for (let i = 0; i < n; i++) c.add(tmpV.set(this.xyz[3 * i], this.xyz[3 * i + 1], this.xyz[3 * i + 2]));
    c.divideScalar(n);
    let r = 1;
    for (let i = 0; i < n; i++) r = Math.max(r, tmpV.set(this.xyz[3 * i], this.xyz[3 * i + 1], this.xyz[3 * i + 2]).distanceTo(c) + this.atomRadius(i));
    this.radius = r + 0.5;
    this.controls.target.copy(c);
    const dir = new THREE.Vector3().subVectors(this.camera.position, c);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    this.ortho.zoom = 1;
    const dist = this.opts.perspective ? this.radius / Math.tan((this.persp.fov * Math.PI) / 360) * 1.25 : 50;
    this.camera.position.copy(c).addScaledVector(dir, dist);
    this.camera.lookAt(c);
    this.updateFrustum();
    this.controls.update();
    this.invalidate();
  }

  /**
   * Look along the normal of the plane through the given (0-based) atoms.
   * 3 atoms a–b–c: plane abc, a–b horizontal. 4 atoms a–b–c–d (a dihedral
   * such as C2–N0=N1–C13): normal (a − b) × (d − c), central bond b–c
   * horizontal, as frame() in photoswitch scripts/plot_orbitals.py.
   */
  alignTo(atoms: number[]): boolean {
    if (atoms.length < 3) return false;
    const p = atoms.map(i => new THREE.Vector3(this.xyz[3 * i], this.xyz[3 * i + 1], this.xyz[3 * i + 2]));
    const four = p.length >= 4;
    const ex = four ? new THREE.Vector3().subVectors(p[2], p[1]) : new THREE.Vector3().subVectors(p[1], p[0]);
    const ez = four
      ? new THREE.Vector3().crossVectors(new THREE.Vector3().subVectors(p[0], p[1]), new THREE.Vector3().subVectors(p[3], p[2]))
      : new THREE.Vector3().crossVectors(new THREE.Vector3().subVectors(p[1], p[0]), new THREE.Vector3().subVectors(p[2], p[0]));
    if (ex.lengthSq() < 1e-10 || ez.lengthSq() < 1e-10) return false;
    ex.normalize();
    ez.addScaledVector(ex, -ez.dot(ex)).normalize();
    const ey = new THREE.Vector3().crossVectors(ez, ex).normalize();
    const target = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(target);
    this.camera.up.copy(ey);
    this.camera.position.copy(target).addScaledVector(ez, dist);
    this.camera.lookAt(target);
    this.controls.update();
    this.invalidate();
    this.changeListeners.forEach(f => f());
    return true;
  }

  /** View along a Cartesian axis. */
  viewAxis(axis: 'x' | 'y' | 'z'): void {
    const target = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(target);
    const d = axis === 'x' ? new THREE.Vector3(1, 0, 0) : axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    if (axis === 'y') this.camera.up.set(0, 0, -1);
    else this.camera.up.set(0, 1, 0);
    this.camera.position.copy(target).addScaledVector(d, dist);
    this.camera.lookAt(target);
    this.controls.update();
    this.invalidate();
    this.changeListeners.forEach(f => f());
  }

  /** Copy camera orientation and zoom from another scene (side-by-side orbitals). */
  syncFrom(other: MoleculeScene): void {
    this.suppressChange = true;
    if (this.opts.perspective !== other.opts.perspective) {
      this.opts.perspective = other.opts.perspective;
      this.switchCamera();
    }
    this.controls.target.copy(other.controls.target);
    this.camera.position.copy(other.camera.position);
    this.camera.up.copy(other.camera.up);
    this.camera.quaternion.copy(other.camera.quaternion);
    this.ortho.zoom = other.ortho.zoom;
    this.radius = other.radius;
    this.updateFrustum();
    this.controls.update();
    this.suppressChange = false;
    this.invalidate();
  }

  // --------------------------------------------------------------- picking

  setPicked(atoms: number[]): void {
    this.picked = atoms.filter(i => i >= 0 && i < this.symbols.length);
    this.rebuild();
  }

  private pickAt(e: PointerEvent): void {
    if (!this.atomMesh || !this.onPick) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObject(this.atomMesh, false)[0];
    if (hit && hit.instanceId !== undefined) this.onPick(hit.instanceId, e.shiftKey || e.ctrlKey || e.metaKey);
    else if (!e.shiftKey) this.onPick(-1, false);
  }

  // --------------------------------------------------------------- labels

  private drawLabels(): void {
    const n = this.symbols.length;
    if (n > 400) {
      this.labelHost.replaceChildren();
      return;
    }
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    const nodes: HTMLElement[] = [];
    for (let i = 0; i < n; i++) {
      tmpV.set(this.xyz[3 * i], this.xyz[3 * i + 1], this.xyz[3 * i + 2]).project(this.camera);
      if (tmpV.z < -1 || tmpV.z > 1) continue;
      const d = document.createElement('span');
      d.textContent = `${elementSymbol(this.symbols[i])}${i + 1}`;
      d.style.transform = `translate(${((tmpV.x + 1) / 2) * w}px, ${((1 - tmpV.y) / 2) * h}px) translate(-50%, -50%)`;
      if (this.picked.includes(i)) d.className = 'on';
      nodes.push(d);
    }
    this.labelHost.replaceChildren(...nodes);
  }

  // --------------------------------------------------------------- isosurfaces

  /** Show isosurfaces (replace the previous ones); empty list clears. */
  setIsosurfaces(meshes: { mesh: MeshData; color: string }[]): void {
    for (const c of [...this.isoGroup.children]) {
      const m = c as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      this.isoGroup.remove(m);
    }
    for (const { mesh, color } of meshes) {
      if (!mesh.indices.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normals, 3));
      g.setIndex(mesh.indices.length > 65535 ? new THREE.Uint32BufferAttribute(mesh.indices, 1) : new THREE.Uint16BufferAttribute(mesh.indices, 1));
      const mat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(color),
        shininess: 60,
        specular: new THREE.Color(0x333333),
        side: THREE.DoubleSide,
        transparent: this.isoOpacity < 0.999,
        opacity: this.isoOpacity,
        depthWrite: this.isoOpacity >= 0.999
      });
      const m = new THREE.Mesh(g, mat);
      m.renderOrder = 2;
      this.isoGroup.add(m);
    }
    this.invalidate();
  }

  setIsoOpacity(v: number): void {
    this.isoOpacity = v;
    for (const c of this.isoGroup.children) {
      const mat = (c as THREE.Mesh).material as THREE.MeshPhongMaterial;
      mat.opacity = v;
      mat.transparent = v < 0.999;
      mat.depthWrite = v >= 0.999;
      mat.needsUpdate = true;
    }
    this.invalidate();
  }

  hasIsosurfaces(): boolean {
    return this.isoGroup.children.length > 0;
  }

  // --------------------------------------------------------------- export

  /** PNG (base64, no data: prefix) at `scale` × the on-screen size, optionally on white. */
  snapshot(scale = 3, background?: string): string {
    const w = Math.max(50, this.el.clientWidth);
    const h = Math.max(50, this.el.clientHeight);
    const ratio = this.renderer.getPixelRatio();
    const prev = new THREE.Color();
    this.renderer.getClearColor(prev);
    if (background) this.renderer.setClearColor(new THREE.Color(background));
    this.renderer.setPixelRatio(scale);
    this.renderer.setSize(w, h, false);
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.renderer.setClearColor(prev);
    this.invalidate();
    return url.slice(url.indexOf(',') + 1);
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.setIsosurfaces([]);
    this.symbols = [];
    this.rebuild();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.el.remove();
  }
}
