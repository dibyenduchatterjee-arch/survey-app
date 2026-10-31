// Every console page calls boot(page). It checks the session, draws the nav, and mounts
// the page. An enumerator is sent back to the survey app before anything else loads.
import { authFetch } from '../../js/auth.js';
import { logout } from '../../js/auth.js';
import { createApi } from './api.js';
import { enter } from './session.js';
import { h, clear } from './ui.js';
import { mountHome } from './home.js';
import { mountForms } from './forms.js';
import { mountSubmissions } from './submissions.js';
import { mountExports } from './exports.js';
import { mountUsers } from './users.js';
import { mountProjects } from './projects.js';
import { mountAudit } from './audit.js';

export const PAGES = {
  home: { title: 'Downloads', href: 'index.html', mount: mountHome },
  projects: { title: 'Projects', href: 'projects.html', mount: mountProjects },
  forms: { title: 'Forms', href: 'forms.html', mount: mountForms },
  submissions: { title: 'Submissions', href: 'submissions.html', mount: mountSubmissions },
  exports: { title: 'Exports', href: 'exports.html', mount: mountExports },
  users: { title: 'Users', href: 'users.html', mount: mountUsers },
  audit: { title: 'Audit', href: 'audit.html', mount: mountAudit },
};

export async function boot(page, opts = {}) {
  const root = opts.root || document.getElementById('app');
  const user = await enter(root, {
    store: opts.store, navigate: opts.navigate, login: opts.login,
    onSignedIn: () => boot(page, opts),
  });
  if (!user) return null;
  const api = createApi(opts.authFetch || authFetch);
  const nav = h('nav', { class: 'nav' },
    h('strong', { class: 'brand', text: 'Evidence Action' }),
    Object.entries(PAGES).map(([k, p]) => h('a', { href: p.href, 'aria-current': k === page ? 'page' : null, text: p.title })),
    h('span', { class: 'who', text: `${user.full_name || user.username} (${user.role})` }),
    h('button', { type: 'button', class: 'signout', text: 'Sign out', onclick: async () => { await (opts.logout || logout)(); location.reload(); } }));
  const main = h('main', { id: 'main' });
  clear(root).append(nav, main);
  const ctx = { api, user, params: new URLSearchParams(opts.search ?? location.search), pollMs: opts.pollMs };
  await PAGES[page].mount(main, ctx);
  return ctx;
}
