// Small, dependency-free JSON Schema validator for client tool arguments.
// Supports the subset used by OpenAI-style function schemas (draft-07/2020-12 core
// keywords plus OpenAPI `nullable`). Unsupported constraints are rejected before
// sending a request; they must never silently turn an invalid argument into a call.

const MAX_ERRORS = 20;
const MAX_DEPTH = 64;
// Patterns come from client tool definitions and run on the shared event loop. Patterns
// with nested quantifiers (catastrophic backtracking, e.g. (a+)+) and very long inputs are
// not checked; such values are left for the client to validate.
const MAX_PATTERN_SOURCE = 1000;
const MAX_PATTERN_INPUT = 20_000;
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d*,)/;
const TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const KEYWORDS = new Set(('$schema $id $comment title description default examples deprecated readOnly writeOnly type required enum const properties additionalProperties items not if then else propertyNames contains additionalItems allOf anyOf oneOf prefixItems $defs definitions patternProperties $ref nullable minLength maxLength pattern minimum maximum exclusiveMinimum exclusiveMaximum multipleOf minItems maxItems uniqueItems minContains maxContains minProperties maxProperties dependentRequired dependentSchemas').split(' '));

// Deliberately bounded subset of regex syntax. Grouping, alternation, backrefs and
// multiple repetitions require a non-backtracking regex engine and are rejected.
function safePattern(source) {
  if (typeof source !== 'string' || source.length > MAX_PATTERN_SOURCE) return false;
  const tokens = source.replace(/\[(?:\\.|[^\]\\])*\]|\\./g, 'x');
  if (/[()|]/.test(tokens) || /\\[1-9]/.test(source)) return false;
  if ((tokens.match(/[+*?]|\{\d+(?:,\d*)?\}/g) ?? []).length > 1) return false;
  if (/[+*?{]/.test(tokens) && !source.startsWith('^')) return false;
  try { new RegExp(source, 'u'); return true; } catch { return false; }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const pointer = path => path.length ? '/' + path.map(p => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/') : '(root)';
const codePoints = value => [...value].length;

function equal(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
}

function matchesType(value, type) {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeOf(value) === type;
}

function compilePattern(source, cache) {
  if (cache.has(source)) return cache.get(source);
  if (source.length > MAX_PATTERN_SOURCE || NESTED_QUANTIFIER.test(source)) { cache.set(source, null); return null; }
  let regex = null;
  try { regex = new RegExp(source, 'u'); } catch { try { regex = new RegExp(source); } catch { regex = null; } }
  cache.set(source, regex);
  return regex;
}

function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let node = root;
  for (const raw of ref.slice(2).split('/')) {
    let key;
    try { key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~'); } catch { return undefined; }
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/** Checks that a schema is structurally usable. Returns a list of problems. */
export function schemaProblems(schema) {
  const problems = [];
  let nodes = 0;
  const visit = (node, path, depth) => {
    if (problems.length >= MAX_ERRORS) return;
    if (++nodes > 10000) { problems.push('schema is too complex'); return; }
    if (typeof node === 'boolean') return;
    if (!isObject(node)) { problems.push(`${pointer(path)} must be an object or boolean schema`); return; }
    if (depth > MAX_DEPTH) { problems.push(`${pointer(path)} is nested too deeply`); return; }
    for (const key of Object.keys(node)) if (!KEYWORDS.has(key)) problems.push(`${pointer(path)}/${key} is not supported`);
    if (node.$ref !== undefined && resolveRef(schema, node.$ref) === undefined) problems.push(`${pointer(path)}/$ref must resolve inside this schema`);
    if (node.pattern !== undefined && !safePattern(node.pattern)) problems.push(`${pointer(path)}/pattern is invalid or outside the bounded regex subset`);
    for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minContains', 'maxContains', 'minProperties', 'maxProperties']) if (node[key] !== undefined && (!Number.isSafeInteger(node[key]) || node[key] < 0)) problems.push(`${pointer(path)}/${key} must be a nonnegative integer`);
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) if (node[key] !== undefined && (typeof node[key] !== 'number' || !Number.isFinite(node[key]) || (key === 'multipleOf' && node[key] <= 0))) problems.push(`${pointer(path)}/${key} must be a finite ${key === 'multipleOf' ? 'positive ' : ''}number`);
    for (const key of ['nullable', 'uniqueItems']) if (node[key] !== undefined && typeof node[key] !== 'boolean') problems.push(`${pointer(path)}/${key} must be boolean`);
    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.length || types.some(t => !TYPES.has(t))) problems.push(`${pointer(path)}/type has an unknown JSON Schema type`);
    }
    if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some(r => typeof r !== 'string'))) problems.push(`${pointer(path)}/required must be an array of strings`);
    if (node.enum !== undefined && !Array.isArray(node.enum)) problems.push(`${pointer(path)}/enum must be an array`);
    if (node.properties !== undefined) {
      if (!isObject(node.properties)) problems.push(`${pointer(path)}/properties must be an object`);
      else for (const [key, child] of Object.entries(node.properties)) visit(child, [...path, 'properties', key], depth + 1);
    }
    for (const key of ['additionalProperties', 'items', 'not', 'if', 'then', 'else', 'propertyNames', 'contains', 'additionalItems']) {
      if (node[key] === undefined) continue;
      if (key === 'items' && Array.isArray(node.items)) node.items.forEach((child, i) => visit(child, [...path, 'items', i], depth + 1));
      else visit(node[key], [...path, key], depth + 1);
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
      if (node[key] === undefined) continue;
      if (!Array.isArray(node[key]) || !node[key].length) problems.push(`${pointer(path)}/${key} must be a non-empty array`);
      else node[key].forEach((child, i) => visit(child, [...path, key, i], depth + 1));
    }
    for (const key of ['$defs', 'definitions', 'patternProperties', 'dependentSchemas']) {
      if (node[key] === undefined) continue;
      if (!isObject(node[key])) problems.push(`${pointer(path)}/${key} must be an object`);
      else for (const [name, child] of Object.entries(node[key])) {
        if (key === 'patternProperties' && !safePattern(name)) problems.push(`${pointer(path)}/patternProperties contains an unsupported pattern`);
        visit(child, [...path, key, name], depth + 1);
      }
    }
    if (node.dependentRequired !== undefined && (!isObject(node.dependentRequired) || Object.values(node.dependentRequired).some(v => !Array.isArray(v) || v.some(k => typeof k !== 'string')))) problems.push(`${pointer(path)}/dependentRequired must map names to string arrays`);
  };
  visit(schema, [], 0);
  return problems;
}

/** Compiles a validator: returns `value => ({ valid, errors: [{path, message}] })`. */
export function compileSchema(schema) {
  const problems = schemaProblems(schema);
  if (problems.length) throw new Error('Unsupported JSON Schema: ' + problems.slice(0, 3).join('; '));
  const root = schema;
  const patterns = new Map();
  const unsupported = new Set();
  let steps = 0, exhausted = false;
  function validate(node, value, path, errors, depth) {
    if (++steps > 50000) { exhausted = true; return; }
    if (errors.length >= MAX_ERRORS) return;
    if (node === true || node === undefined) return;
    if (node === false) { errors.push({ path: pointer(path), message: 'no value is allowed here' }); return; }
    if (!isObject(node)) return;
    if (depth > MAX_DEPTH) { errors.push({ path: pointer(path), message: 'schema recursion is too deep' }); return; }
    if (node.$ref !== undefined) {
      const target = resolveRef(root, node.$ref);
      if (target === undefined) errors.push({ path: pointer(path), message: 'unresolved schema reference' });
      else validate(target, value, path, errors, depth + 1);
    }
    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.some(t => matchesType(value, t)) && !(value === null && node.nullable === true)) {
        errors.push({ path: pointer(path), message: `expected ${types.join(' or ')}, received ${typeOf(value)}` });
        return;
      }
    }
    if (node.const !== undefined && !equal(value, node.const)) errors.push({ path: pointer(path), message: `must equal ${JSON.stringify(node.const)}` });
    if (Array.isArray(node.enum) && !node.enum.some(option => equal(option, value))) errors.push({ path: pointer(path), message: `must be one of ${JSON.stringify(node.enum).slice(0, 300)}` });
    if (typeof value === 'string') {
      const length = codePoints(value);
      if (Number.isFinite(node.minLength) && length < node.minLength) errors.push({ path: pointer(path), message: `must contain at least ${node.minLength} characters` });
      if (Number.isFinite(node.maxLength) && length > node.maxLength) errors.push({ path: pointer(path), message: `must contain at most ${node.maxLength} characters` });
      if (typeof node.pattern === 'string') {
        const regex = compilePattern(node.pattern, patterns);
        if (value.length > MAX_PATTERN_INPUT || !regex || !regex.test(value)) errors.push({ path: pointer(path), message: `must match pattern ${node.pattern} within ${MAX_PATTERN_INPUT} characters` });
      }
    }
    if (typeof value === 'number') {
      if (Number.isFinite(node.minimum) && (node.exclusiveMinimum === true ? value <= node.minimum : value < node.minimum)) errors.push({ path: pointer(path), message: `must be ${node.exclusiveMinimum === true ? '>' : '>='} ${node.minimum}` });
      if (Number.isFinite(node.maximum) && (node.exclusiveMaximum === true ? value >= node.maximum : value > node.maximum)) errors.push({ path: pointer(path), message: `must be ${node.exclusiveMaximum === true ? '<' : '<='} ${node.maximum}` });
      if (typeof node.exclusiveMinimum === 'number' && value <= node.exclusiveMinimum) errors.push({ path: pointer(path), message: `must be > ${node.exclusiveMinimum}` });
      if (typeof node.exclusiveMaximum === 'number' && value >= node.exclusiveMaximum) errors.push({ path: pointer(path), message: `must be < ${node.exclusiveMaximum}` });
      if (typeof node.multipleOf === 'number' && node.multipleOf > 0) {
        const quotient = value / node.multipleOf;
        if (Math.abs(quotient - Math.round(quotient)) > 1e-9) errors.push({ path: pointer(path), message: `must be a multiple of ${node.multipleOf}` });
      }
    }
    if (Array.isArray(value)) {
      if (Number.isFinite(node.minItems) && value.length < node.minItems) errors.push({ path: pointer(path), message: `must contain at least ${node.minItems} items` });
      if (Number.isFinite(node.maxItems) && value.length > node.maxItems) errors.push({ path: pointer(path), message: `must contain at most ${node.maxItems} items` });
      if (node.uniqueItems === true) {
        const seen = new Set();
        for (let j = 0; j < value.length; j++) {
          const key = stableStringify(value[j]);
          if (seen.has(key)) { errors.push({ path: pointer([...path, j]), message: 'duplicates an earlier item' }); break; }
          seen.add(key);
        }
      }
      const tuple = Array.isArray(node.prefixItems) ? node.prefixItems : Array.isArray(node.items) ? node.items : null;
      const rest = Array.isArray(node.prefixItems) ? node.items : Array.isArray(node.items) ? node.additionalItems : node.items;
      value.forEach((item, index) => {
        if (tuple && index < tuple.length) validate(tuple[index], item, [...path, index], errors, depth + 1);
        else if (rest !== undefined) validate(rest, item, [...path, index], errors, depth + 1);
      });
      if (node.contains !== undefined) {
        const matches = value.filter(item => { const e = []; validate(node.contains, item, path, e, depth + 1); return !e.length; }).length;
        const minimum = Number.isFinite(node.minContains) ? node.minContains : 1;
        if (matches < minimum) errors.push({ path: pointer(path), message: 'does not contain a required item' });
        if (Number.isFinite(node.maxContains) && matches > node.maxContains) errors.push({ path: pointer(path), message: 'contains too many matching items' });
      }
    }
    if (isObject(value)) {
      const keys = Object.keys(value);
      if (Number.isFinite(node.minProperties) && keys.length < node.minProperties) errors.push({ path: pointer(path), message: `must have at least ${node.minProperties} properties` });
      if (Number.isFinite(node.maxProperties) && keys.length > node.maxProperties) errors.push({ path: pointer(path), message: `must have at most ${node.maxProperties} properties` });
      for (const key of Array.isArray(node.required) ? node.required : []) {
        if (!Object.hasOwn(value, key)) errors.push({ path: pointer([...path, key]), message: 'is required' });
      }
      if (isObject(node.dependentRequired)) {
        for (const [key, needed] of Object.entries(node.dependentRequired)) {
          if (Object.hasOwn(value, key) && Array.isArray(needed)) for (const other of needed) if (!Object.hasOwn(value, other)) errors.push({ path: pointer([...path, other]), message: `is required when ${key} is present` });
        }
      }
      if (isObject(node.dependentSchemas)) for (const [key, child] of Object.entries(node.dependentSchemas)) if (Object.hasOwn(value, key)) validate(child, value, path, errors, depth + 1);
      const properties = isObject(node.properties) ? node.properties : {};
      const patternEntries = isObject(node.patternProperties) ? Object.entries(node.patternProperties).map(([source, child]) => [compilePattern(source, patterns), child]) : [];
      // Property names are short, so patternProperties needs no input-length guard beyond MAX_PATTERN_SOURCE.
      for (const key of keys) {
        let matched = false;
        if (Object.hasOwn(properties, key)) { matched = true; validate(properties[key], value[key], [...path, key], errors, depth + 1); }
        for (const [regex, child] of patternEntries) {
          if (key.length > MAX_PATTERN_INPUT) { errors.push({ path: pointer(path), message: 'property name exceeds pattern validation limit' }); break; }
          if (regex && regex.test(key)) { matched = true; validate(child, value[key], [...path, key], errors, depth + 1); }
        }
        if (node.propertyNames !== undefined) validate(node.propertyNames, key, [...path, key], errors, depth + 1);
        if (!matched && node.additionalProperties !== undefined) {
          if (node.additionalProperties === false) errors.push({ path: pointer([...path, key]), message: 'is not an allowed property' });
          else validate(node.additionalProperties, value[key], [...path, key], errors, depth + 1);
        }
      }
    }
    if (Array.isArray(node.allOf)) for (const child of node.allOf) validate(child, value, path, errors, depth + 1);
    const branchErrors = child => { const e = []; validate(child, value, path, e, depth + 1); return e; };
    if (Array.isArray(node.anyOf) && !node.anyOf.some(child => !branchErrors(child).length)) errors.push({ path: pointer(path), message: 'does not match any allowed schema (anyOf)' });
    if (Array.isArray(node.oneOf)) {
      const count = node.oneOf.filter(child => !branchErrors(child).length).length;
      if (count !== 1) errors.push({ path: pointer(path), message: count ? 'matches more than one schema (oneOf)' : 'does not match any allowed schema (oneOf)' });
    }
    if (node.not !== undefined && !branchErrors(node.not).length) errors.push({ path: pointer(path), message: 'matches a forbidden schema (not)' });
    if (node.if !== undefined) {
      const passes = !branchErrors(node.if).length;
      if (passes && node.then !== undefined) validate(node.then, value, path, errors, depth + 1);
      if (!passes && node.else !== undefined) validate(node.else, value, path, errors, depth + 1);
    }
  }
  const validator = value => {
    steps = 0; exhausted = false;
    const errors = [];
    validate(root, value, [], errors, 0);
    if (exhausted) errors.push({ path: '(root)', message: 'schema validation complexity limit exceeded' });
    return { valid: errors.length === 0, errors: errors.slice(0, MAX_ERRORS) };
  };
  validator.unsupportedRefs = () => [...unsupported];
  return validator;
}

/** Stable JSON: sorts object keys so equal values always serialize identically. */
export function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(v => stableStringify(v === undefined ? null : v)).join(',') + ']';
  if (isObject(value)) return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
