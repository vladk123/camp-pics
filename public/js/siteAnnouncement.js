(function initializeSiteAnnouncementScript() {
  'use strict';

  let initialized = false;

  function initialize() {
    if (initialized) return;
    initialized = true;

    const dialog = document.getElementById('site-announcement-dialog');
    if (!dialog) return;

    const trigger = document.getElementById('site-announcement-trigger');
    const closeButton = document.getElementById('site-announcement-close');
    const cta = document.getElementById('site-announcement-cta');
    const key = dialog.dataset.announcementKey;
    const revision = Number(dialog.dataset.announcementRevision);
    const autoOpen = dialog.dataset.announcementAutoOpen === 'true';
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(key) ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    ) {
      return;
    }

    const dismissalKey = `campPicsAnnouncementDismissed:${key}:${revision}`;
    let manualTrigger = null;

    function isDismissed() {
      try {
        return window.localStorage?.getItem(dismissalKey) === 'true';
      } catch {
        return false;
      }
    }

    function recordDismissal() {
      try {
        window.localStorage?.setItem(dismissalKey, 'true');
      } catch {
        // Storage may be unavailable; the dialog remains fully usable.
      }
    }

    function restoreManualFocus() {
      manualTrigger?.focus();
      manualTrigger = null;
    }

    function openDialog(openedBy = null) {
      manualTrigger = openedBy;
      try {
        if (!dialog.open) dialog.showModal();
      } catch {
        dialog.setAttribute('open', '');
      }
      closeButton?.focus();
    }

    function closeDialog() {
      recordDismissal();
      try {
        dialog.close();
      } catch {
        dialog.removeAttribute('open');
        restoreManualFocus();
      }
    }

    trigger?.addEventListener('click', event => {
      event.preventDefault();
      openDialog(trigger);
    });
    closeButton?.addEventListener('click', closeDialog);
    cta?.addEventListener('click', recordDismissal);
    dialog.addEventListener('click', event => {
      if (event.target === dialog) closeDialog();
    });
    dialog.addEventListener('cancel', recordDismissal);
    dialog.addEventListener('close', () => {
      recordDismissal();
      restoreManualFocus();
    });

    if (autoOpen && !isDismissed()) openDialog();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
