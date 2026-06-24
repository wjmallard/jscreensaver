// teapot.js -- faithful ES-module port of xscreensaver's hacks/glx/teapot.c
// (the Martin Newell / SGI Utah teapot, used by pipes as a rare easter-egg
// "factory" shape). Ports unit_teapot's HAVE_GLMAP path: the 10 Bezier base
// patches, each reflected across y (and, for the first 6, across x) to make 32
// bicubic patches, evaluated on a grid*grid mesh -- exactly what glMap2f /
// glEvalMesh2 do on the desktop build (which is the canonical visual). Normals
// come from the surface partials (du x dv), matching GL_AUTO_NORMAL.
//
// The control net is the verbatim teapot-data.js. unit_teapot's fixed pre-
// transform -- glRotatef(270,1,0,0) glScalef(.5,.5,.5) glTranslatef(0,0,-1.5) --
// is baked into the output, so this returns the teapot already in pipes object
// space (MakeTeapot then only adds an orientation spin). Result is a flat
// { pos, nor } triangle soup, cached.

import { patchdata, cpdata } from './teapot-data.js';

// cubic Bernstein basis and its derivative at t.
function bern(t) {
  const it = 1 - t;
  return [it * it * it, 3 * t * it * it, 3 * t * t * it, t * t * t];
}
function dbern(t) {
  const it = 1 - t;
  return [-3 * it * it, 3 * it * (1 - 3 * t), 3 * t * (2 - 3 * t), 3 * t * t];
}

// pre-transform (unit_teapot): T(0,0,-1.5) then S(0.5) then Rx(270).
// Rx(270): cos=0, sin=-1 -> (x,y,z) -> (x, z, -y).
function xfPos(x, y, z) {
  z -= 1.5;
  x *= 0.5; y *= 0.5; z *= 0.5;
  return [x, z, -y];
}
function xfNor(x, y, z) { return [x, z, -y]; }   // rotation part only

let cached = null;

// Build the teapot mesh at the given grid resolution (unit_teapot uses 12).
export function buildTeapot(grid = 12) {
  if (cached) return cached;

  const pos = [], nor = [];
  const N = grid + 1;

  // evaluate one 4x4 control net `cp` (cp[a][b] = [x,y,z]) into the soup.
  function evalPatch(cp) {
    const P = new Array(N * N);   // {p:[x,y,z], n:[x,y,z]} per lattice point
    for (let iu = 0; iu < N; iu++) {
      const Bu = bern(iu / grid), dBu = dbern(iu / grid);
      for (let iv = 0; iv < N; iv++) {
        const Bv = bern(iv / grid), dBv = dbern(iv / grid);
        let px = 0, py = 0, pz = 0;
        let ux = 0, uy = 0, uz = 0;   // dP/du
        let vx = 0, vy = 0, vz = 0;   // dP/dv
        for (let a = 0; a < 4; a++) {
          for (let b = 0; b < 4; b++) {
            const c = cp[a][b];
            const wp = Bu[a] * Bv[b], wu = dBu[a] * Bv[b], wv = Bu[a] * dBv[b];
            px += wp * c[0]; py += wp * c[1]; pz += wp * c[2];
            ux += wu * c[0]; uy += wu * c[1]; uz += wu * c[2];
            vx += wv * c[0]; vy += wv * c[1]; vz += wv * c[2];
          }
        }
        // surface normal = dP/du x dP/dv (GL_AUTO_NORMAL).
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-7) { nx /= len; ny /= len; nz /= len; } else { nx = ny = nz = 0; }
        P[iu * N + iv] = { p: xfPos(px, py, pz), n: nx || ny || nz ? xfNor(nx, ny, nz) : null };
      }
    }
    const emit = (a, b, c) => {
      // fall back to the geometric face normal at degenerate (pole) vertices.
      let fn = null;
      const ensure = () => {
        if (fn) return fn;
        const ex = b.p[0] - a.p[0], ey = b.p[1] - a.p[1], ez = b.p[2] - a.p[2];
        const fx = c.p[0] - a.p[0], fy = c.p[1] - a.p[1], fz = c.p[2] - a.p[2];
        let gx = ey * fz - ez * fy, gy = ez * fx - ex * fz, gz = ex * fy - ey * fx;
        const l = Math.hypot(gx, gy, gz) || 1;
        return (fn = [gx / l, gy / l, gz / l]);
      };
      for (const v of [a, b, c]) {
        pos.push(v.p[0], v.p[1], v.p[2]);
        const n = v.n || ensure();
        nor.push(n[0], n[1], n[2]);
      }
    };
    for (let iu = 0; iu < grid; iu++) {
      for (let iv = 0; iv < grid; iv++) {
        const a = P[iu * N + iv], b = P[(iu + 1) * N + iv];
        const c = P[(iu + 1) * N + iv + 1], d = P[iu * N + iv + 1];
        emit(a, b, c); emit(a, c, d);
      }
    }
  }

  // 10 base patches; reflect across y (q) and, for the first 6, across x (r,s).
  for (let i = 0; i < 10; i++) {
    const p = [], q = [], r = [], s = [];
    for (let j = 0; j < 4; j++) {
      p[j] = []; q[j] = []; r[j] = []; s[j] = [];
      for (let k = 0; k < 4; k++) {
        const base = cpdata[patchdata[i][j * 4 + k]];
        const mir = cpdata[patchdata[i][j * 4 + (3 - k)]];
        p[j][k] = [base[0], base[1], base[2]];
        q[j][k] = [mir[0], -mir[1], mir[2]];
        if (i < 6) {
          r[j][k] = [-mir[0], mir[1], mir[2]];
          s[j][k] = [-base[0], -base[1], base[2]];
        }
      }
    }
    evalPatch(p);
    evalPatch(q);
    if (i < 6) { evalPatch(r); evalPatch(s); }
  }

  cached = { pos: new Float32Array(pos), nor: new Float32Array(nor) };
  return cached;
}
