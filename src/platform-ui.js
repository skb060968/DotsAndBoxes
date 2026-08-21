let toastTimer;

export function showScreen(id) {
  document.querySelectorAll('.screen').forEach((screen) => {
    screen.hidden = screen.id !== id;
  });
  document.getElementById(id)?.focus({ preventScroll: true });
}

export function showToast(message, duration = 2200) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add('visible'));
  toastTimer = setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => { toast.hidden = true; }, 180);
  }, duration);
}

/**
 * Custom confirmation dialog. Uses a native <dialog> element (not window.confirm),
 * so the browser never prefixes it with the site's address. Resolves to true when
 * confirmed, false when cancelled or dismissed.
 */
export function showConfirm(message, { confirmText = 'Confirm', cancelText = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'confirm-dialog';

    const text = document.createElement('p');
    text.className = 'confirm-message';
    text.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'button quiet';
    cancel.textContent = cancelText;

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'button primary';
    confirm.textContent = confirmText;

    actions.append(cancel, confirm);
    dialog.append(text, actions);
    document.body.append(dialog);

    let settled = false;
    const close = (result) => {
      if (settled) return;
      settled = true;
      try { dialog.close(); } catch (_) {}
      dialog.remove();
      resolve(result);
    };
    cancel.addEventListener('click', () => close(false));
    confirm.addEventListener('click', () => close(true));
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(false); });

    dialog.showModal();
    confirm.focus();
  });
}
