// core/router.js — path-pattern router with :params, *splat, route groups,
// mounting and route listing (used by OpenAPI/doctor output).
const PARAM_RE = /:([A-Za-z0-9_]+)/g;

function compilePattern(pattern) {
  const names = [];
  const regexSrc = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(PARAM_RE, (_, name) => {
      names.push(name);
      return '([^/]+)';
    })
    .replace(/\*/g, () => {
      names.push('splat');
      return '(.*)';
    });
  return { regex: new RegExp(`^${regexSrc}$`), names };
}

export class Router {
  constructor() {
    this.routes = [];
  }

  /**
   * opts: { name, auth: 'admin'|'project'|'public', perm, rateLimit: {max,windowMs},
   *         multipart: bool, raw: bool, description }
   */
  add(method, pattern, handler, opts = {}) {
    method = method.toUpperCase();
    const { regex, names } = compilePattern(pattern);
    const route = { method, pattern, regex, names, handler, opts, order: this.routes.length };
    this.routes.push(route);
    return route;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }
  options(p, h, o) { return this.add('OPTIONS', p, h, o); }

  // Mount a sub-router under a prefix, preserving its route options.
  use(prefix, subRouter) {
    for (const r of subRouter.routes) {
      this.add(r.method, prefix + r.pattern, r.handler, { ...r.opts, mounted: true });
    }
    return this;
  }

  group(prefix, registerFn, baseOpts = {}) {
    const sub = new Router();
    registerFn(sub);
    for (const r of sub.routes) {
      this.add(r.method, prefix + r.pattern, r.handler, { ...baseOpts, ...r.opts });
    }
    return this;
  }

  match(method, pathname) {
    let fallback = null;
    for (const r of this.routes) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      if (r.method === method || r.method === 'ALL') {
        const params = {};
        r.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
        return { route: r, params };
      }
      if (r.method === 'HEAD' && method === 'GET') {
        const params = {};
        r.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
        return { route: r, params, head: true };
      }
      fallback = { route: r, params: {} };
    }
    return fallback ? { methodMismatch: true, ...fallback } : null;
  }

  // Normalize a path that may end with "/" for matching purposes.
  static normalize(pathname) {
    if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
    return pathname;
  }

  list() {
    return this.routes.map(({ method, pattern, opts }) => ({ method, pattern, auth: opts.auth || 'public', name: opts.name, description: opts.description }));
  }
}
