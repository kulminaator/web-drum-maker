// Generic nested-path helpers (plan step 13): let the UI reach any patch
// parameter from a descriptor's `{path, ...}` without knowing the patch
// shape. Pure functions, no state — the UI reads a slider default with
// getPath, writes slider values back with setPath, and the engine then
// renders the same live patch object.
//
// A path is a dot-separated list of segments — object keys or array
// indices: 'layers.0.carrier.freq', 'layers.1.levelEnv.3.t'.
//
// Both reader and writer are STRICT: a path that does not resolve to a
// value already present in the object throws a descriptive Error.
// Design choice (plan step 13: "setPath creates missing intermediates
// (or throws — pick and document)"): setPath deliberately does NOT
// create missing intermediates. Descriptor paths address the live
// engine patch built by the voice modules, so a failing path is a typo
// or a stale descriptor; silently creating the missing keys would
// corrupt the patch instead of surfacing the bug. The descriptor
// sanity tests in test/params.test.mjs rely on the throw.

// Split and validate a path: non-empty string, no empty segments
// ('a..b' would parse '' as array index 0 — reject it up front).
const segmentsOf = (path) => {
  if (typeof path !== 'string' || path === '')
    throw new Error('params: path must be a non-empty dot-separated string');
  const segments = path.split('.');
  if (segments.some((s) => s === ''))
    throw new Error(`params: path '${path}' has an empty segment`);
  return segments;
};

// Follow one segment of a path into `node`, throwing on any broken step
// (traversal through a non-object, a non-numeric array index, or a key
// that does not exist). The error names the offending segment and path.
const childOf = (node, segment, path) => {
  if (node === null || typeof node !== 'object')
    throw new Error(
      `params: path '${path}' breaks at '${segment}' (value is a ${typeof node}, not an object)`,
    );
  if (Array.isArray(node)) {
    if (!/^\d+$/.test(segment))
      throw new Error(`params: path '${path}' needs an array index at '${segment}'`);
    const index = Number(segment);
    if (index >= node.length)
      throw new Error(
        `params: path '${path}' array index ${index} out of range (length ${node.length})`,
      );
    return node[index];
  }
  if (!(segment in node))
    throw new Error(`params: path '${path}' key '${segment}' not found`);
  return node[segment];
};

// Resolve `path` against `obj` down to the object that OWNS the final
// segment, returning `{container, key}`. Throws (see header) if any
// step is missing — including the final key, so setPath never invents
// structure that the engine patch does not already have.
const resolve = (obj, path) => {
  const segments = segmentsOf(path);
  const last = segments.length - 1;
  let container = obj;
  for (let i = 0; i < last; i++) container = childOf(container, segments[i], path);
  if (container === null || typeof container !== 'object')
    throw new Error(`params: path '${path}' ends inside a non-object`);
  const key = segments[last];
  const exists = Array.isArray(container)
    ? /^\d+$/.test(key) && Number(key) < container.length
    : key in container;
  if (!exists)
    throw new Error(
      `params: path '${path}' does not resolve (no such ${
        Array.isArray(container) ? `array index` : 'key'
      } '${key}')`,
    );
  return { container, key };
};

// Read the value at `path` (a reference, for object/array values).
export const getPath = (obj, path) => {
  const { container, key } = resolve(obj, path);
  return container[key];
};

// Write `value` at `path`, in place (the UI edits the live patch — the
// container is mutated, never rebuilt). Throws like getPath when the
// path does not already exist (strict, see header).
export const setPath = (obj, path, value) => {
  const { container, key } = resolve(obj, path);
  container[key] = value;
};

// Clamp `value` to [min, max]. Guards the slider → setPath path: a
// range input can report values at its endpoints, and the descriptor
// sanity tests guarantee the defaults are already in range, but clamp
// keeps the write side total regardless.
export const clamp = (value, min, max) => {
  if (!Number.isFinite(value))
    throw new Error(`params: clamp value must be finite, got ${value}`);
  if (!(min <= max))
    throw new Error(`params: clamp min ${min} must be ≤ max ${max}`);
  return Math.min(max, Math.max(min, value));
};
