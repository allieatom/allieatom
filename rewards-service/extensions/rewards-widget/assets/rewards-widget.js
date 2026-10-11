/* Better Rhodes Rewards storefront widget (no dependencies).
   Mount points: [data-br-rewards="launcher|rewards-page|referral-page"]. Data comes from the signed Shopify app proxy. */
(function () {
  'use strict';
  if (window.__brRewardsLoaded) return; window.__brRewardsLoaded = true;

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  var money = function (cents) { var d = cents / 100; return '$' + (Number.isInteger(d) ? d.toFixed(0) : d.toFixed(2)); };
  var fmtDate = function (iso) { if (!iso) return ''; try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return String(iso).slice(0, 10); } };
  var params = new URLSearchParams(location.search);
  var ref = params.get('ref');
  try { if (ref) localStorage.setItem('br_ref', ref); else ref = localStorage.getItem('br_ref'); } catch (e) { /* storage blocked */ }

  function api(base, path, body) {
    return fetch(base + path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('Request failed (' + r.status + ')')); return j; }); });
  }

  // ---------- view fragments ----------
  function vSummary(d, cfg) {
    var m = d.member, next = m.nextTier;
    var pct = next && next.minSpendCents ? Math.min(100, Math.round(100 * (1 - next.remainingCents / next.minSpendCents))) : 0;
    return '<div class="brw-hero">' +
      '<div class="brw-muted">' + esc(m.firstName ? 'Hi ' + m.firstName + ',' : 'Your balance') + '</div>' +
      '<div class="brw-balance">' + esc(m.pointsBalance.toLocaleString()) + ' <span style="font-size:1rem;font-weight:600">points</span></div>' +
      '<div><span class="brw-pill">' + esc(m.tier) + ' member</span>' + (m.pointsExpireAt ? ' <span class="brw-muted">· points expire ' + esc(fmtDate(m.pointsExpireAt)) + '</span>' : '') + '</div>' +
      (next && next.minSpendCents ? '<div class="brw-progress"><span style="width:' + pct + '%"></span></div><div class="brw-muted">Spend ' + esc(money(next.remainingCents)) + ' more to reach ' + esc(next.name) + '</div>' : '') +
      '</div>';
  }
  function vEarn(p) {
    return '<div class="brw-card"><h4 class="brw-h">Ways to earn</h4>' + p.waysToEarn.map(function (w) { return '<div class="brw-row"><div><div>' + esc(w.title) + '</div><div class="brw-muted">' + esc(w.description) + '</div></div></div>'; }).join('') + '</div>';
  }
  function vRedeem(d) {
    return '<div class="brw-card"><h4 class="brw-h">Ways to redeem</h4>' + d.redemptionOptions.map(function (o) {
      return '<div class="brw-row"><div><div>' + esc(o.title) + '</div><div class="brw-muted">' + esc(o.points) + ' points</div></div>' +
        '<button class="brw-btn brw-btn--sm" data-action="redeem" data-key="' + esc(o.key) + '"' + (o.affordable ? '' : ' disabled') + '>Redeem</button></div>';
    }).join('') + '<div class="brw-msg" data-slot="redeem-msg"></div></div>';
  }
  function vCoupons(d) {
    if (!d.activeCoupons.length) return '';
    return '<div class="brw-card"><h4 class="brw-h">Your rewards</h4>' + d.activeCoupons.map(function (c) {
      return '<div class="brw-row"><div><div>' + esc(c.title) + '</div><div class="brw-muted">Issued ' + esc(fmtDate(c.createdAt)) + '</div></div><div style="display:flex;gap:.5rem;align-items:center"><span class="brw-code">' + esc(c.code) + '</span><a class="brw-btn brw-btn--sm brw-btn--ghost" href="/discount/' + encodeURIComponent(c.code) + '?redirect=/cart">Apply</a></div></div>';
    }).join('') + '</div>';
  }
  function vHistory(d) {
    if (!d.history.length) return '';
    return '<div class="brw-card"><h4 class="brw-h">History</h4>' + d.history.slice(0, 10).map(function (h) {
      return '<div class="brw-row"><div><div>' + esc(h.reason) + '</div><div class="brw-muted">' + esc(fmtDate(h.at)) + '</div></div><strong>' + (h.points > 0 ? '+' : '') + esc(h.points) + '</strong></div>';
    }).join('') + '</div>';
  }
  function vTiers(p) {
    var known = p.tiers.filter(function (t) { return t.minSpendCents != null; });
    return '<div class="brw-card"><h4 class="brw-h">VIP tiers</h4>' + known.map(function (t) { return '<div class="brw-row"><div>' + esc(t.name) + '</div><div class="brw-muted">' + (t.minSpendCents ? 'Spend ' + esc(money(t.minSpendCents)) + ' in 12 months' : 'Everyone') + '</div></div>'; }).join('') + '</div>';
  }
  function vReferral(d, cfg) {
    var m = d.member;
    return '<div class="brw-card"><h4 class="brw-h">Refer a friend</h4><div class="brw-muted">' + esc(d.program.referral.friend) + ' for them, ' + esc(d.program.referral.advocatePoints) + ' points for you.</div>' +
      '<div class="brw-form" style="margin-top:.75rem"><input class="brw-input" readonly value="' + esc(m.referralLink) + '"><button class="brw-btn brw-btn--sm" data-action="copy" data-copy="' + esc(m.referralLink) + '">Copy link</button></div>' +
      '<form class="brw-form" style="margin-top:.75rem" data-action="share-email"><input class="brw-input" name="email" type="email" placeholder="Friend\'s email" required><button class="brw-btn brw-btn--sm brw-btn--ghost" type="submit">Send invite</button></form>' +
      '<div class="brw-msg" data-slot="share-msg"></div></div>';
  }
  function vFriendClaim(cfg) {
    return '<div class="brw-card"><h4 class="brw-h">Your friend sent you 10% off</h4><div class="brw-muted">Enter your email and we\'ll create your one-time code for your first order.</div>' +
      '<form class="brw-form" style="margin-top:.75rem" data-action="claim"><input class="brw-input" name="email" type="email" placeholder="you@example.com" required><button class="brw-btn brw-btn--sm" type="submit">Get my code</button></form>' +
      '<div class="brw-msg" data-slot="claim-msg"></div></div>';
  }
  function vLoggedOut(d, cfg) {
    return '<div class="brw-card"><h4 class="brw-h">' + esc(d.program.name) + '</h4><div class="brw-muted">Earn points on every order and turn them into savings.</div>' +
      '<div style="display:flex;gap:.6rem;margin-top:.9rem;flex-wrap:wrap"><a class="brw-btn" href="' + esc(cfg.registerUrl) + '">Join now</a><a class="brw-btn brw-btn--ghost" href="' + esc(cfg.loginUrl) + '">Sign in</a></div></div>' +
      (ref ? vFriendClaim(cfg) : '') + vEarn(d.program) + '<div class="brw-card"><h4 class="brw-h">Ways to redeem</h4>' + d.program.waysToRedeem.map(function (w) { return '<div class="brw-row"><div>' + esc(w.title) + '</div><div class="brw-muted">' + esc(w.points) + ' points</div></div>'; }).join('') + '</div>';
  }

  // ---------- behaviour ----------
  function wire(root, cfg, reload) {
    root.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-action]'); if (!btn) return;
      var action = btn.getAttribute('data-action');
      if (action === 'redeem') {
        ev.preventDefault(); btn.disabled = true;
        var slot = root.querySelector('[data-slot="redeem-msg"]');
        api(cfg.proxy, '/redeem', { optionKey: btn.getAttribute('data-key') }).then(function (r) {
          if (slot) slot.innerHTML = '<span class="brw-msg--ok">Your code: <span class="brw-code">' + esc(r.code) + '</span> <a class="brw-btn brw-btn--sm brw-btn--ghost" href="/discount/' + encodeURIComponent(r.code) + '?redirect=/cart">Apply to cart</a></span>';
          reload();
        }).catch(function (e) { btn.disabled = false; if (slot) slot.innerHTML = '<span class="brw-msg--err">' + esc(e.message) + '</span>'; });
      } else if (action === 'copy') {
        ev.preventDefault();
        var text = btn.getAttribute('data-copy');
        (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy link'; }, 1500); }).catch(function () { window.prompt('Copy your link', text); });
        api(cfg.proxy, '/referral/share', { channel: 'link' }).catch(function () {});
      } else if (action === 'toggle') {
        ev.preventDefault(); root.classList.toggle('brw-open'); var p = root.querySelector('.brw-panel'); if (p) p.hidden = !root.classList.contains('brw-open');
      }
    });
    root.addEventListener('submit', function (ev) {
      var form = ev.target.closest('form[data-action]'); if (!form) return;
      ev.preventDefault();
      var email = form.querySelector('[name=email]').value;
      if (form.getAttribute('data-action') === 'share-email') {
        var s = root.querySelector('[data-slot="share-msg"]');
        api(cfg.proxy, '/referral/share', { channel: 'email', recipients: [email] }).then(function () { s.innerHTML = '<span class="brw-msg--ok">Invite sent to ' + esc(email) + '.</span>'; form.reset(); }).catch(function (e) { s.innerHTML = '<span class="brw-msg--err">' + esc(e.message) + '</span>'; });
      } else if (form.getAttribute('data-action') === 'claim') {
        var c = root.querySelector('[data-slot="claim-msg"]');
        api(cfg.proxy, '/referral/claim', { referralCode: ref, email: email }).then(function (r) { c.innerHTML = '<span class="brw-msg--ok">' + esc(r.title) + ': <span class="brw-code">' + esc(r.code) + '</span> <a class="brw-btn brw-btn--sm brw-btn--ghost" href="/discount/' + encodeURIComponent(r.code) + '?redirect=/collections/all">Shop now</a></span>'; }).catch(function (e) { c.innerHTML = '<span class="brw-msg--err">' + esc(e.message) + '</span>'; });
      }
    });
  }

  function mount(el) {
    var kind = el.getAttribute('data-br-rewards');
    var cfg = { proxy: el.getAttribute('data-proxy') || '/apps/rewards', loginUrl: el.getAttribute('data-login-url') || '/account/login', registerUrl: el.getAttribute('data-register-url') || '/account/register', label: el.getAttribute('data-label') || 'Rewards', heading: el.getAttribute('data-heading') || '', subheading: el.getAttribute('data-subheading') || '', position: el.getAttribute('data-position') || 'right', rewardsUrl: el.getAttribute('data-rewards-url') || '/pages/loyalty-rewards', referUrl: el.getAttribute('data-refer-url') || '/pages/loyalty-refer' };
    el.classList.add('brw');
    var body;
    if (kind === 'launcher') {
      el.classList.add('brw-launcher', 'brw-launcher--' + cfg.position);
      el.innerHTML = '<div class="brw-panel" hidden><div class="brw-panel__head"><h3>' + esc(cfg.label) + '</h3><button class="brw-panel__close" data-action="toggle" aria-label="Close">×</button></div><div class="brw-panel__body" data-slot="body"><div class="brw-muted">Loading…</div></div></div>' +
        '<button class="brw-btn brw-launcher__btn" data-action="toggle" aria-expanded="false">★ ' + esc(cfg.label) + '</button>';
    } else {
      el.classList.add('brw-page');
      el.innerHTML = (cfg.heading ? '<h2 style="margin:0">' + esc(cfg.heading) + '</h2>' : '') + (cfg.subheading ? '<p class="brw-muted" style="margin:0">' + esc(cfg.subheading) + '</p>' : '') + '<div data-slot="body" style="display:grid;gap:1rem"><div class="brw-muted">Loading…</div></div>';
    }
    body = el.querySelector('[data-slot="body"]');

    function render(d) {
      if (!d.authenticated) { body.innerHTML = vLoggedOut(d, cfg); return; }
      if (kind === 'referral-page') body.innerHTML = vSummary(d, cfg) + vReferral(d, cfg);
      else if (kind === 'rewards-page') body.innerHTML = vSummary(d, cfg) + '<div class="brw-grid">' + vEarn(d.program) + vRedeem(d) + '</div>' + vCoupons(d) + '<div class="brw-grid">' + vReferral(d, cfg) + vTiers(d.program) + '</div>' + vHistory(d);
      else body.innerHTML = vSummary(d, cfg) + vRedeem(d) + vCoupons(d) + vReferral(d, cfg) + '<a class="brw-btn brw-btn--ghost" href="' + esc(cfg.rewardsUrl) + '">See all ways to earn</a>';
    }
    function load() { return api(cfg.proxy, '/me').then(render).catch(function (e) { body.innerHTML = '<div class="brw-msg brw-msg--err">Rewards are temporarily unavailable. ' + esc(e.message) + '</div>'; }); }
    wire(el, cfg, load);
    load();
  }

  function init() { Array.prototype.forEach.call(document.querySelectorAll('[data-br-rewards]:not(.brw)'), mount); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.BRRewards = { init: init };
})();
