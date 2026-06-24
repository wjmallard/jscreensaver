// easing.js -- a faithful, standalone ES-module port of xscreensaver's
// utils/easing.c (Jamie Zawinski, 2025): the CSS / jQuery easing functions.
//
//   ease(fn, x) -> double      // fn is one of the EASE_* constants below
//
// Each EASE_* constant IS the easing function itself, so `ease(EASE_IN_OUT_SINE, r)`
// reads exactly like the C call `ease(EASE_IN_OUT_SINE, r)`. x is normally in [0,1].
// Pure math module: no DOM, no THREE dependency. Used by cubestack.js and cubetwist.js,
// the same shared helper the .c files include via "easing.h".

const PI = Math.PI;

function easeNone (x) { return x; }

function easeInSine (x) { return 1 - Math.cos((x * PI) / 2); }
function easeOutSine (x) { return Math.sin((x * PI) / 2); }
function easeInOutSine (x) { return -(Math.cos(PI * x) - 1) / 2; }

function easeInQuad (x) { return x * x; }
function easeOutQuad (x) { return 1 - (1 - x) * (1 - x); }
function easeInOutQuad (x) {
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

function easeInCubic (x) { return x * x * x; }
function easeOutCubic (x) { return 1 - Math.pow(1 - x, 3); }
function easeInOutCubic (x) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function easeInQuart (x) { return x * x * x * x; }
function easeOutQuart (x) { return 1 - Math.pow(1 - x, 4); }
function easeInOutQuart (x) {
  return x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2;
}

function easeInQuint (x) { return x * x * x * x * x; }
function easeOutQuint (x) { return 1 - Math.pow(1 - x, 5); }
function easeInOutQuint (x) {
  return x < 0.5 ? 16 * x * x * x * x * x : 1 - Math.pow(-2 * x + 2, 5) / 2;
}

function easeInExpo (x) { return x === 0 ? 0 : Math.pow(2, 10 * x - 10); }
function easeOutExpo (x) { return x === 1 ? 1 : 1 - Math.pow(2, -10 * x); }
function easeInOutExpo (x) {
  return (x === 0 ? 0 :
          x === 1 ? 1 :
          x < 0.5 ? Math.pow(2, 20 * x - 10) / 2
                  : (2 - Math.pow(2, -20 * x + 10)) / 2);
}

function easeInCirc (x) { return 1 - Math.sqrt(1 - Math.pow(x, 2)); }
function easeOutCirc (x) { return Math.sqrt(1 - Math.pow(x - 1, 2)); }
function easeInOutCirc (x) {
  return (x < 0.5
          ? (1 - Math.sqrt(1 - Math.pow(2 * x, 2))) / 2
          : (Math.sqrt(1 - Math.pow(-2 * x + 2, 2)) + 1) / 2);
}

function easeInBack (x) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return c3 * x * x * x - c1 * x * x;
}
function easeOutBack (x) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}
function easeInOutBack (x) {
  const c1 = 1.70158;
  const c2 = c1 * 1.525;
  return (x < 0.5
          ? (Math.pow(2 * x, 2) * ((c2 + 1) * 2 * x - c2)) / 2
          : (Math.pow(2 * x - 2, 2) * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2);
}

function easeInElastic (x) {
  const c4 = (2 * PI) / 3;
  return (x === 0 ? 0 :
          x === 1 ? 1 :
          -Math.pow(2, 10 * x - 10) * Math.sin((x * 10 - 10.75) * c4));
}
function easeOutElastic (x) {
  const c4 = (2 * PI) / 3;
  return (x === 0 ? 0 :
          x === 1 ? 1 :
          Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1);
}
function easeInOutElastic (x) {
  const c5 = (2 * PI) / 4.5;
  return (x === 0 ? 0 :
          x === 1 ? 1 :
          x < 0.5
          ? -(Math.pow(2, 20 * x - 10) * Math.sin((20 * x - 11.125) * c5)) / 2
          :  (Math.pow(2, -20 * x + 10) * Math.sin((20 * x - 11.125) * c5)) / 2 + 1);
}

function easeOutBounce (x) {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) {
    return n1 * x * x;
  } else if (x < 2 / d1) {
    x -= (1.5 / d1);
    return n1 * x * x + 0.75;
  } else if (x < 2.5 / d1) {
    x -= (2.25 / d1);
    return n1 * x * x + 0.9375;
  } else {
    x -= (2.625 / d1);
    return n1 * x * x + 0.984375;
  }
}
function easeInBounce (x) { return 1 - easeOutBounce(1 - x); }
function easeInOutBounce (x) {
  return (x < 0.5
          ? (1 - easeOutBounce(1 - 2 * x)) / 2
          : (1 + easeOutBounce(2 * x - 1)) / 2);
}

// The enum from easing.h, each constant bound to its function so call sites read
// like the C (`ease(EASE_IN_OUT_SINE, x)`).
export const EASE_NONE = easeNone;
export const EASE_IN_SINE = easeInSine;
export const EASE_OUT_SINE = easeOutSine;
export const EASE_IN_OUT_SINE = easeInOutSine;
export const EASE_IN_QUAD = easeInQuad;
export const EASE_OUT_QUAD = easeOutQuad;
export const EASE_IN_OUT_QUAD = easeInOutQuad;
export const EASE_IN_CUBIC = easeInCubic;
export const EASE_OUT_CUBIC = easeOutCubic;
export const EASE_IN_OUT_CUBIC = easeInOutCubic;
export const EASE_IN_QUART = easeInQuart;
export const EASE_OUT_QUART = easeOutQuart;
export const EASE_IN_OUT_QUART = easeInOutQuart;
export const EASE_IN_QUINT = easeInQuint;
export const EASE_OUT_QUINT = easeOutQuint;
export const EASE_IN_OUT_QUINT = easeInOutQuint;
export const EASE_IN_EXPO = easeInExpo;
export const EASE_OUT_EXPO = easeOutExpo;
export const EASE_IN_OUT_EXPO = easeInOutExpo;
export const EASE_IN_CIRC = easeInCirc;
export const EASE_OUT_CIRC = easeOutCirc;
export const EASE_IN_OUT_CIRC = easeInOutCirc;
export const EASE_IN_BACK = easeInBack;
export const EASE_OUT_BACK = easeOutBack;
export const EASE_IN_OUT_BACK = easeInOutBack;
export const EASE_IN_ELASTIC = easeInElastic;
export const EASE_OUT_ELASTIC = easeOutElastic;
export const EASE_IN_OUT_ELASTIC = easeInOutElastic;
export const EASE_IN_BOUNCE = easeInBounce;
export const EASE_OUT_BOUNCE = easeOutBounce;
export const EASE_IN_OUT_BOUNCE = easeInOutBounce;

// ease(fn, x): the .c's dispatcher. fn is an EASE_* constant (the function itself).
export function ease (fn, x) {
  return fn(x);
}

export default ease;
