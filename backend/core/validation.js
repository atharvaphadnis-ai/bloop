// core/validation.js — dependency-free schema validation used by every form,
// REST insert/update path and the settings API.
// Schema shape: { field: { type, required, min, max, pattern, enum, items, properties, default } }
export const TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'email', 'url', 'uuid', 'json', 'date', 'cron'];

export class ValidationError extends Error {
  constructor(errors) {
    super('Validation failed');
    this.name = 'ValidationError';
    this.status = 400;
    this.code = 'VALIDATION_ERROR';
    this.details = errors;
  }
}

export function validate(schema, data, { coerce = true, stripUnknown = true } = {}) {
  const errors = [];
  const out = {};
  if (data == null || typeof data !== 'object') data = {};
  for (const [field, rules] of Object.entries(schema)) {
    let v = data[field];
    if (v === undefined && rules.default !== undefined) v = rules.default;
    if (coerce) v = coerceValue(rules.type, v);
    const missing = v === undefined || v === null || v === '';
    if (missing) {
      if (rules.required) errors.push({ field, message: `${field} is required` });
      else if (v === undefined) continue;
      else out[field] = v;
      continue;
    }
    const err = checkField(field, rules, v);
    if (err) { errors.push(err); continue; }
    out[field] = v;
  }
  if (!stripUnknown) {
    for (const [k, v] of Object.entries(data)) {
      if (!(k in out) && schema[k] === undefined) out[k] = v;
    }
  }
  return { ok: errors.length === 0, errors, value: out };
}

export function validateOrThrow(schema, data, opts) {
  const r = validate(schema, data, opts);
  if (!r.ok) throw new ValidationError(r.errors);
  return r.value;
}

function coerceValue(type, v) {
  if (v === undefined || v === null) return v;
  try {
    if (type === 'number' && typeof v === 'string' && v.trim() !== '') return Number(v);
    if (type === 'integer' && typeof v === 'string' && v.trim() !== '') return parseInt(v, 10);
    if (type === 'boolean' && typeof v === 'string') {
      if (['true', '1', 'yes', 'on'].includes(v.toLowerCase())) return true;
      if (['false', '0', 'no', 'off'].includes(v.toLowerCase())) return false;
    }
    if ((type === 'object' || type === 'json' || type === 'array') && typeof v === 'string') {
      return JSON.parse(v);
    }
  } catch { return v; }
  return v;
}

function checkField(field, rules, v) {
  const type = rules.type || 'string';
  switch (type) {
    case 'string':
    case 'email':
    case 'url':
    case 'uuid':
    case 'date':
    case 'cron': {
      if (typeof v !== 'string') return err(field, `${field} must be a string`);
      if (rules.min !== undefined && v.length < rules.min) return err(field, `${field} must be at least ${rules.min} characters`);
      if (rules.max !== undefined && v.length > rules.max) return err(field, `${field} must be at most ${rules.max} characters`);
      if (rules.pattern && !new RegExp(rules.pattern).test(v)) return err(field, rules.patternMessage || `${field} has an invalid format`);
      if (rules.enum && !rules.enum.includes(v)) return err(field, `${field} must be one of: ${rules.enum.join(', ')}`);
      if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return err(field, `${field} must be a valid email address`);
      if (type === 'url') { try { new URL(v); } catch { return err(field, `${field} must be a valid URL`); } }
      if (type === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return err(field, `${field} must be a UUID`);
      if (type === 'cron' && !isValidCron(v)) return err(field, `${field} must be a valid cron expression (e.g. "*/5 * * * *")`);
      if (type === 'date' && Number.isNaN(Date.parse(v))) return err(field, `${field} must be a valid date`);
      break;
    }
    case 'number':
    case 'integer': {
      if (typeof v !== 'number' || Number.isNaN(v)) return err(field, `${field} must be a number`);
      if (type === 'integer' && !Number.isInteger(v)) return err(field, `${field} must be an integer`);
      if (rules.min !== undefined && v < rules.min) return err(field, `${field} must be >= ${rules.min}`);
      if (rules.max !== undefined && v > rules.max) return err(field, `${field} must be <= ${rules.max}`);
      break;
    }
    case 'boolean': {
      if (typeof v !== 'boolean') return err(field, `${field} must be a boolean`);
      break;
    }
    case 'object': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return err(field, `${field} must be an object`);
      if (rules.properties) {
        for (const [sub, subRules] of Object.entries(rules.properties)) {
          const e = checkField(`${field}.${sub}`, subRules, v[sub]);
          if (e && subRules.required) return e;
        }
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(v)) return err(field, `${field} must be an array`);
      if (rules.min !== undefined && v.length < rules.min) return err(field, `${field} must contain at least ${rules.min} items`);
      if (rules.max !== undefined && v.length > rules.max) return err(field, `${field} must contain at most ${rules.max} items`);
      if (rules.items) {
        for (let i = 0; i < v.length; i++) {
          const e = checkField(`${field}[${i}]`, rules.items, v[i]);
          if (e) return e;
        }
      }
      break;
    }
    case 'json': {
      if (typeof v === 'string') {
        try { JSON.parse(v); } catch { return err(field, `${field} must be valid JSON`); }
      } else if (typeof v !== 'object' && typeof v !== 'number' && typeof v !== 'boolean') {
        return err(field, `${field} must be JSON-serializable`);
      }
      break;
    }
    default:
      return err(field, `${field} has unknown type ${type}`);
  }
  return null;
}

function err(field, message) {
  return { field, message };
}

export function isValidCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges = [
    { min: 0, max: 59 }, { min: 0, max: 23 }, { min: 1, max: 31 },
    { min: 1, max: 12 }, { min: 0, max: 7 },
  ];
  return parts.every((p, i) => {
    if (p === '*') return true;
    for (const seg of p.split(',')) {
      const m = /^(?:\*\/(\d+)|(\d+)(?:-(\d+))?(?:\/(\d+))?)$/.exec(seg);
      if (!m) return false;
      const { min, max } = ranges[i];
      if (m[1] !== undefined) { const step = +m[1]; return step >= 1 && step <= max; }
      const a = +m[2], b = m[3] !== undefined ? +m[3] : a;
      if (a < min || a > max || b < min || b > max || a > b) return false;
      if (i === 4 && b === 7) return true; // sunday as 7
      if (m[4] !== undefined && +m[4] < 1) return false;
    }
    return true;
  });
}

// Basic input sanity helpers shared by REST / NoSQL / storage layers.
export function sanitizeIdentifier(name) {
  // Table / column names must be simple identifiers to prevent injection
  // anywhere a name cannot be parameterized.
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) {
    throw new ValidationError([{ field: 'identifier', message: `invalid identifier: ${JSON.stringify(name)}` }]);
  }
  return name;
}

export function safeJsonParse(text, dflt = null) {
  try { return JSON.parse(text); } catch { return dflt; }
}
