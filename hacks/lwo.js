// lwo.js -- faithful ES-module port of xscreensaver's hacks/glx/buildlwo.c
// (Ed Mackey, 1997), the Lightwave Object display-list builder used by pipes for
// its "factory" gadgetry. The model data lives in the generated pipeobjs.js;
// this module interprets it exactly as BuildLWO() does.
//
// BuildLWO walks the `pols` stream: each polygon is a record [K, idx0..idx_{K-1},
// surface#] (K = *pols, num_pnts = K+2 in the C's counter). For K>=3 it pulls one
// FACE normal from the `normals` stream (flat shading -- glNormal3fv once per
// polygon) and fills it as a GL_POLYGON. K=1/2 would be GL_POINTS/GL_LINES (no
// solid geometry); the stream is 0-terminated. We fan-triangulate each polygon
// (the convex GL_POLYGON fill) and keep the per-polygon face normal on every
// vertex -- a flat-shaded triangle soup in object space, cached per model.
//
// (BuildLWO ignores struct lwo's `smoothnormals`, and so do we -- it is NULL in
// every pipeobjs model anyway.) Winding is moot: pipes draws DoubleSide.

const cache = new WeakMap();

// Expand a model {num_pnts, pnts, normals, pols} into a flat triangle soup
// { pos: Float32Array, nor: Float32Array } (9 floats per triangle each). Cached.
export function buildLWO(model) {
  const hit = cache.get(model);
  if (hit) return hit;

  const { pnts, normals, pols } = model;
  const pos = [], nor = [];
  let p = 0;        // cursor into pols (BuildLWO's ++pols)
  let ni = 0;       // cursor into normals (3 floats consumed per K>=3 polygon)
  let np = 0;       // BuildLWO's running counter (num_pnts)
  let face = null;  // current polygon's face normal (null for points/lines)
  let poly = [];    // current polygon's accumulated vertex positions

  for (;;) {
    if (np <= 0) {
      np = pols[p] + 2;
      if (np < 3) break;        // 0-terminator (or degenerate): done
      poly = [];
      if (np >= 5) {            // a real polygon (K>=3): read its face normal
        face = [normals[ni], normals[ni + 1], normals[ni + 2]];
        ni += 3;
      } else {
        face = null;            // K=1/2 -> GL_POINTS/GL_LINES: no fill, no normal
      }
    } else if (np === 1) {
      // glEnd: flush the polygon as a triangle fan (v0, vk, vk+1). Lightwave
      // polygons are CW-front (pipes.c draws the LWO lists under glFrontFace(GL_CW)),
      // while three is CCW-front; so wind each triangle to AGREE with its (outward)
      // face normal -- otherwise DoubleSide flips the normal inward -> dark gray.
      if (face && poly.length >= 3) {
        const a = poly[0];
        for (let k = 1; k + 1 < poly.length; k++) {
          let b = poly[k], c = poly[k + 1];
          const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
          const fx = c[0] - a[0], fy = c[1] - a[1], fz = c[2] - a[2];
          const gx = ey * fz - ez * fy, gy = ez * fx - ex * fz, gz = ex * fy - ey * fx;
          if (gx * face[0] + gy * face[1] + gz * face[2] < 0) { const t = b; b = c; c = t; }
          pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
          nor.push(face[0], face[1], face[2], face[0], face[1], face[2], face[0], face[1], face[2]);
        }
      }
    } else {
      const idx = pols[p];
      poly.push([pnts[idx * 3], pnts[idx * 3 + 1], pnts[idx * 3 + 2]]);
    }
    np--; p++;
  }

  const out = { pos: new Float32Array(pos), nor: new Float32Array(nor) };
  cache.set(model, out);
  return out;
}

// Bake a triangle soup (from buildLWO / the teapot) into a Builder at the current
// MStack matrix, with a uniform linear vertex color. Winding is moot (DoubleSide).
export function addTris(B, stack, tris, col) {
  const { pos, nor } = tris;
  B.setMatrix(stack.matrix());
  for (let i = 0; i < pos.length; i += 9) {
    B.tri(
      [pos[i], pos[i + 1], pos[i + 2]],
      [pos[i + 3], pos[i + 4], pos[i + 5]],
      [pos[i + 6], pos[i + 7], pos[i + 8]],
      [nor[i], nor[i + 1], nor[i + 2]],
      [nor[i + 3], nor[i + 4], nor[i + 5]],
      [nor[i + 6], nor[i + 7], nor[i + 8]],
      col, true,
    );
  }
  B.setMatrix(null);
}

// Convenience: expand + bake an LWO model in one call.
export function addLWO(B, stack, model, col) {
  addTris(B, stack, buildLWO(model), col);
}
