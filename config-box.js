// config-box.js
// Renders a hack's config controls into a host-provided container. The host
// owns the config box (open/close, the `c` key, the title); this just builds
// the rows from the hack's `params` schema, mutating `config` live and calling
// `onReinit()` after a structural (non-live) change.
//
//   renderConfig(container, { config, params, onReinit })
//
// param: { key, label, type: 'range', min, max, step, default,
//          live,                       // true: takes effect next frame
//          lowLabel, highLabel, unit, invert }   // all optional
//      or { key, label, type: 'checkbox', default, live }

// Colours read the shared --phosphor-* palette defined in host.css; the rgba()
// reset-button fills are --phosphor (95,221,131) at low alpha (var() can't
// supply rgba channels, so they stay literal).
const CSS = `
.cfg-row { margin-bottom: 13px; }
.cfg-row:last-child { margin-bottom: 0; }
.cfg-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 3px; }
.cfg-label { color: var(--phosphor-bright); }
.cfg-val { color: var(--phosphor-mid); font-variant-numeric: tabular-nums; }
.cfg-range { width: 100%; height: 16px; margin: 2px 0 0; cursor: pointer; accent-color: var(--phosphor-accent); }
.cfg-ends { display: flex; justify-content: space-between; margin-top: 1px; font-size: 10.5px; color: var(--phosphor-dim); }
.cfg-check { display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--phosphor-bright); margin-bottom: 13px; }
.cfg-check input { width: 14px; height: 14px; cursor: pointer; accent-color: var(--phosphor-accent); }
.cfg-radios { display: flex; flex-wrap: wrap; gap: 5px 14px; margin-top: 4px; }
.cfg-radio { display: flex; align-items: center; gap: 6px; cursor: pointer; color: var(--phosphor-bright); }
.cfg-radio input { accent-color: var(--phosphor-accent); cursor: pointer; }
.cfg-reset {
  width: 100%; margin-top: 14px; padding: 6px;
  background: rgba(95, 221, 131, 0.08); border: 1px solid var(--phosphor-border); border-radius: 6px;
  color: var(--phosphor-bright); font: inherit; font-size: 12px; cursor: pointer;
}
.cfg-reset:hover { background: rgba(95, 221, 131, 0.16); }
`;

let stylesInjected = false;

function injectStyles() {
  if (stylesInjected) return;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  stylesInjected = true;
}

function decimalsFor(step) {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

function formatValue(value, param) {
  const text = Number(value).toFixed(decimalsFor(param.step || 1));
  return param.unit ? `${text}${param.unit}` : text;
}

export function renderConfig(container, { config, params, onReinit }) {
  injectStyles();
  container.textContent = '';
  const reinit = onReinit || (() => {});
  const setters = [];   // apply a value to config + DOM without reinit (for Reset)

  for (const param of params) {
    if (param.type === 'checkbox') {
      const row = document.createElement('label');
      row.className = 'cfg-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!config[param.key];
      const span = document.createElement('span');
      span.textContent = param.label;
      row.appendChild(input);
      row.appendChild(span);
      container.appendChild(row);

      input.addEventListener('change', () => {
        config[param.key] = input.checked;
        if (!param.live) reinit();
      });
      setters.push({ param, apply: (v) => { input.checked = !!v; config[param.key] = !!v; } });
    } else if (param.type === 'select') {
      const row = document.createElement('div');
      row.className = 'cfg-row';
      const label = document.createElement('div');
      label.className = 'cfg-label';
      label.textContent = param.label;
      row.appendChild(label);

      const group = document.createElement('div');
      group.className = 'cfg-radios';
      const radios = [];
      for (const opt of param.options) {
        const lbl = document.createElement('label');
        lbl.className = 'cfg-radio';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'cfg-' + param.key;
        input.checked = config[param.key] === opt.value;
        const span = document.createElement('span');
        span.textContent = opt.label;
        lbl.appendChild(input);
        lbl.appendChild(span);
        group.appendChild(lbl);
        input.addEventListener('change', () => {
          if (!input.checked) return;
          config[param.key] = opt.value;
          if (!param.live) reinit();
        });
        radios.push({ input, value: opt.value });
      }
      row.appendChild(group);
      container.appendChild(row);
      setters.push({
        param,
        apply: (v) => {
          for (const r of radios) r.input.checked = r.value === v;
          config[param.key] = v;
        },
      });
    } else {
      const row = document.createElement('div');
      row.className = 'cfg-row';

      const head = document.createElement('div');
      head.className = 'cfg-head';
      const label = document.createElement('span');
      label.className = 'cfg-label';
      label.textContent = param.label;
      const val = document.createElement('span');
      val.className = 'cfg-val';
      val.textContent = formatValue(config[param.key], param);
      head.appendChild(label);
      head.appendChild(val);
      row.appendChild(head);

      const input = document.createElement('input');
      input.type = 'range';
      input.className = 'cfg-range';
      input.min = param.min;
      input.max = param.max;
      input.step = param.step;
      input.value = config[param.key];
      if (param.invert) input.style.direction = 'rtl';   // drag right lowers value
      row.appendChild(input);

      if (param.lowLabel || param.highLabel) {
        const ends = document.createElement('div');
        ends.className = 'cfg-ends';
        const lo = document.createElement('span');
        lo.textContent = param.lowLabel || '';
        const hi = document.createElement('span');
        hi.textContent = param.highLabel || '';
        ends.appendChild(lo);
        ends.appendChild(hi);
        row.appendChild(ends);
      }
      container.appendChild(row);

      input.addEventListener('input', () => {
        const v = Number(input.value);
        config[param.key] = v;
        val.textContent = formatValue(v, param);
        if (!param.live) reinit();
      });
      setters.push({
        param,
        apply: (v) => {
          input.value = v;
          config[param.key] = Number(v);
          val.textContent = formatValue(v, param);
        },
      });
    }
  }

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'cfg-reset';
  reset.textContent = 'Reset to defaults';
  reset.addEventListener('click', () => {
    for (const { param, apply } of setters) apply(param.default);
    reinit();
  });
  container.appendChild(reset);
}
