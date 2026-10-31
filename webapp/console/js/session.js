// Who is at the keyboard, and are they allowed here?
//
// Hiding things by role is presentation only: the server refuses what a role may not do,
// whatever this page shows. What this file adds is the courtesy of not leaving an
// enumerator on a screen that will only ever answer 403.
import * as defaultStore from '../../js/db.js';
import { login as defaultLogin } from '../../js/auth.js';
import { h, clear } from './ui.js';

export const STAFF_ROLES = ['admin', 'supervisor'];
export const PWA_HOME = '../';

// -> { user } when allowed, or { user: null, reason: 'signed_out' | 'not_staff' }
export async function currentStaff(store = defaultStore) {
  let session;
  try { session = await store.getSession(); } catch { session = null; }
  if (!session || !session.access_token || session.needs_login || !session.user) {
    return { user: null, reason: 'signed_out' };
  }
  if (!STAFF_ROLES.includes(session.user.role)) return { user: null, reason: 'not_staff', role: session.user.role };
  return { user: session.user };
}

function loginForm(root, { login, onDone }) {
  const err = h('p', { class: 'msg bad', role: 'alert', hidden: true });
  const user = h('input', { name: 'username', autocomplete: 'username', required: true, id: 'login-user' });
  const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true, id: 'login-pass' });
  const form = h('form', { class: 'card login', onsubmit: async e => {
    e.preventDefault();
    err.hidden = true;
    try {
      await login(user.value.trim(), pass.value);
      onDone();
    } catch (ex) {
      err.textContent = ex.message || 'Sign in failed';
      err.hidden = false;
    }
  } },
  h('h1', { text: 'Evidence Action survey console' }),
  h('label', { for: 'login-user', text: 'Username' }), user,
  h('label', { for: 'login-pass', text: 'Password' }), pass,
  err,
  h('button', { class: 'primary', type: 'submit', text: 'Sign in' }));
  clear(root).append(form);
}

// Decides what the page shows. Returns the staff user, or null if it has handed the
// screen over to a login form or sent the visitor away.
export async function enter(root, { store = defaultStore, navigate, login = defaultLogin, onSignedIn } = {}) {
  const r = await currentStaff(store);
  if (r.user) return r.user;
  if (r.reason === 'not_staff') {
    clear(root).append(h('p', { class: 'msg', text: 'This console is for supervisors and administrators. Taking you back to the survey app.' }));
    (navigate || (u => location.replace(u)))(PWA_HOME);
    return null;
  }
  loginForm(root, { login, onDone: () => onSignedIn && onSignedIn() });
  return null;
}
