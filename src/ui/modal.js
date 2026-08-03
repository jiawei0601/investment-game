// modal.js — shared modal interaction module for the static UI.
//
// The app has several overlays with different business actions, but their
// accessibility mechanics are identical: move focus into the overlay, keep
// Tab navigation inside it, close on Escape, and restore the previous focus.
// Keeping those mechanics behind one Module gives app.js a small Interface and
// prevents each modal from growing its own subtly different implementation.

const modalStates = new WeakMap();

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(modal) {
  return [...modal.querySelectorAll(FOCUSABLE_SELECTOR)].filter((el) => {
    if (el.hidden) return false;
    return el.getClientRects().length > 0;
  });
}

function firstOpenModal() {
  return [...document.querySelectorAll('.modal-overlay:not([hidden])')].at(-1) ?? null;
}

export function openModal(modal, { initialFocus = null, onEscape = null } = {}) {
  if (!modal) return;

  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modalStates.set(modal, { previousFocus, onEscape });
  modal.hidden = false;

  const target =
    (typeof initialFocus === 'string' ? modal.querySelector(initialFocus) : initialFocus) ??
    focusableElements(modal)[0];
  target?.focus();
}

export function closeModal(modal) {
  if (!modal) return;
  const state = modalStates.get(modal);
  modal.hidden = true;
  modalStates.delete(modal);

  const previous = state?.previousFocus;
  if (previous?.isConnected && !previous.hidden && !previous.closest('[hidden]')) previous.focus();
}

export function isModalOpen(modal) {
  return Boolean(modal && !modal.hidden);
}

export function installModalKeyboardSupport() {
  document.addEventListener('keydown', (event) => {
    const modal = firstOpenModal();
    if (!modal) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      const state = modalStates.get(modal);
      if (state?.onEscape) state.onEscape();
      else closeModal(modal);
      return;
    }

    if (event.key !== 'Tab') return;

    const focusables = focusableElements(modal);
    if (focusables.length === 0) {
      event.preventDefault();
      modal.focus();
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}
