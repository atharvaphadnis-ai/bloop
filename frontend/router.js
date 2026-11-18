// router.js — hash router with a registry, breadcrumbs and async page render.
import { clear, qs, icon, state } from './components.js';

const routes = new Map();
let booted = false;

export function register(path, def) {
  routes.set(path, def);
}

export function go(path) {
  if (location.hash === `#/${path}`) render();
  else location.hash = `#/${path}`;
}

export function currentRoute() {
  const raw = location.hash.replace(/^#\/?/, '').split('?')[0];
  return raw || 'overview';
}

export function start() {
  if (booted) return;
  booted = true;
  window.addEventListener('hashchange', render);
  render();
}

export async function render() {
  const page = qs('#page');
  if (!page) return;
  const name = currentRoute();
  const def = routes.get(name) || routes.get('overview');
  // breadcrumbs
  const bc = qs('#breadcrumbs');
  clear(bc);
  if (def?.group) bc.append(h('span', { class: 'link', onclick: () => go(def.groupPath || def.group.toLowerCase()) }, def.group), h('span', { class: 'sep' }, '/'));
  if (state.project && def?.projectScoped !== false && name !== 'overview' && name !== 'projects') {
    bc.append(h('span', { class: 'link', onclick: () => go('projects') }, state.project.name), h('span', { class: 'sep' }, '/'));
  }
  bc.append(h('span', { style: { color: 'var(--text)' } }, def?.title || name));
  document.title = `${def?.title || 'Bloop'} · Bloop`;
  clear(page);
  try {
    await def.render(page, {});
  } catch (err) {
    clear(page).append(
      h('div', { class: 'error-box' }, `Failed to render page "${name}": ${err.message}`),
      h('div', { style: { marginTop: '12px' } },
        h('button', { class: 'btn btn-secondary', onclick: () => render() }, icon('refresh'), 'Retry')));
  }
}

// tiny local h re-export for breadcrumbs
import { h } from './components.js';

export { routes };
