/* Keyboard and focus behavior shared by both interfaces. */
(() => {
  'use strict';
  const focusable = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';
  const visibleControls = container => [...container.querySelectorAll(focusable)].filter(el => el.getClientRects().length && !el.closest('[inert]'));
  const dialogs = [...document.querySelectorAll('.modal-overlay')];
  const lastFocus = new Map();
  const sidebar = document.getElementById('sidebar');
  const hamburger = document.getElementById('hamburger-btn');
  const main = document.querySelector('.main');
  const mobile = window.matchMedia('(max-width:780px)');
  const openDialog = () => dialogs.findLast(el => !el.classList.contains('hidden'));

  function syncLocks() {
    const dialog = openDialog();
    const menuOpen = !!(sidebar?.classList.contains('open') && mobile.matches);
    if (sidebar) sidebar.inert = mobile.matches && !menuOpen;
    document.body.style.overflow = dialog || menuOpen ? 'hidden' : '';
    for (const id of ['app-shell','admin-shell','auth-screen','login-screen']) {
      const el = document.getElementById(id);
      if (el) el.inert = !!dialog;
    }
    if (main) main.inert = menuOpen;
  }

  for (const overlay of dialogs) {
    const card = overlay.querySelector('.modal-card');
    const title = card?.querySelector('h3');
    if (card) {
      card.setAttribute('role','dialog');
      card.setAttribute('aria-modal','true');
      card.tabIndex = -1;
      if (title) {
        title.id ||= `${overlay.id}-title`;
        card.setAttribute('aria-labelledby',title.id);
      }
    }
    overlay.querySelectorAll('.modal-close').forEach(button => button.setAttribute('aria-label',document.documentElement.lang === 'ru' ? 'Закрыть окно' : 'Close dialog'));
    let wasHidden = overlay.classList.contains('hidden');
    new MutationObserver(() => {
      const hidden = overlay.classList.contains('hidden');
      if (hidden === wasHidden) return;
      wasHidden = hidden;
      if (!hidden) lastFocus.set(overlay,document.activeElement);
      syncLocks();
      if (!hidden) {
        requestAnimationFrame(() => {
          const input = visibleControls(overlay).find(el => ['INPUT','SELECT','TEXTAREA'].includes(el.tagName));
          (input || visibleControls(overlay)[0] || card)?.focus();
        });
      } else {
        const previous = lastFocus.get(overlay);
        if (previous?.isConnected) previous.focus({preventScroll:true});
        lastFocus.delete(overlay);
      }
    }).observe(overlay,{attributes:true,attributeFilter:['class']});
  }

  if (sidebar) {
    new MutationObserver(() => {
      syncLocks();
      const opened = sidebar.classList.contains('open') && mobile.matches;
      hamburger?.setAttribute('aria-expanded',String(opened));
      if (opened) requestAnimationFrame(() => sidebar.querySelector('.nav-item.active')?.focus());
    }).observe(sidebar,{attributes:true,attributeFilter:['class']});
    mobile.addEventListener('change',() => {
      if (!mobile.matches) {
        sidebar.classList.remove('open');
        document.getElementById('sidebar-overlay')?.classList.remove('open');
        hamburger?.setAttribute('aria-expanded','false');
      }
      syncLocks();
    });
  }

  document.addEventListener('keydown',event => {
    const dialog = openDialog();
    const menuOpen = sidebar?.classList.contains('open') && mobile.matches;
    const dropdown = document.getElementById('user-dropdown');
    if (event.key === 'Escape') {
      if (dialog) {
        dialog.classList.add('hidden');
      } else if (menuOpen) {
        sidebar.classList.remove('open');
        document.getElementById('sidebar-overlay')?.classList.remove('open');
        hamburger?.focus();
      } else if (dropdown && !dropdown.classList.contains('hidden')) {
        dropdown.classList.add('hidden');
        document.getElementById('user-menu-btn')?.focus();
      }
    }
    if (event.key === 'Tab' && (dialog || menuOpen)) {
      const controls = visibleControls(dialog || sidebar);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first) return;
      if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) {
        event.preventDefault();last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) {
        event.preventDefault();first.focus();
      }
    }
  });

  const dropdown = document.getElementById('user-dropdown');
  if (dropdown) new MutationObserver(() => {
    document.getElementById('user-menu-btn')?.setAttribute('aria-expanded',String(!dropdown.classList.contains('hidden')));
  }).observe(dropdown,{attributes:true,attributeFilter:['class']});

  document.querySelectorAll('.error-text').forEach(el => el.setAttribute('role','alert'));
  document.querySelectorAll('.source-chips').forEach(container => {
    const sync = () => container.querySelectorAll('.chip').forEach(button => button.setAttribute('aria-pressed',String(button.classList.contains('active'))));
    sync();
    new MutationObserver(sync).observe(container,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  });
  document.querySelectorAll('.auth-tabs,.pill-group,.tabs').forEach(container => {
    const sync = () => container.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed',String(button.classList.contains('active'))));
    sync();
    new MutationObserver(sync).observe(container,{subtree:true,attributes:true,attributeFilter:['class']});
  });
  syncLocks();
})();
