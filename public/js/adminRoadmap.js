(function initializeAdminRoadmapScript() {
  'use strict';

  let initialized = false;
  let lastDetailTrigger = null;

  function initialize() {
    if (initialized) return;
    initialized = true;

    const dialog = document.getElementById('roadmap-detail-dialog');
    const dialogContent = document.getElementById('roadmap-dialog-content');
    const closeButton = document.getElementById('roadmap-dialog-close');
    const detailSources = Array.from(
      document.querySelectorAll('[data-roadmap-detail-id]'),
    );

    if (dialog && dialogContent) {
      for (const trigger of document.querySelectorAll('[data-roadmap-item-id]')) {
        trigger.addEventListener('click', () => {
          const source = detailSources.find(candidate =>
            candidate.dataset.roadmapDetailId === trigger.dataset.roadmapItemId
          );
          if (!source) return;

          const clonedDetails = Array.from(
            source.childNodes,
            node => node.cloneNode(true),
          );
          dialogContent.replaceChildren(...clonedDetails);
          lastDetailTrigger = trigger;
          dialog.showModal();
        });
      }

      closeButton?.addEventListener('click', () => dialog.close());
      dialog.addEventListener('click', event => {
        if (event.target === dialog) dialog.close();
      });
      dialog.addEventListener('close', () => {
        lastDetailTrigger?.focus();
        lastDetailTrigger = null;
      });
    }

    const copyButton = document.getElementById('roadmap-copy-button');
    const copySource = document.getElementById('roadmap-copy-source');
    const copyStatus = document.getElementById('roadmap-copy-status');

    if (!copyButton || !copySource || !copyStatus) return;

    function copyWithFallback(text) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.className = 'roadmap-copy-fallback';
      textarea.setAttribute('readonly', '');
      document.body.appendChild(textarea);
      textarea.select();

      try {
        return document.execCommand?.('copy') === true;
      } catch {
        return false;
      } finally {
        textarea.remove();
        copyButton.focus();
      }
    }

    copyButton.addEventListener('click', async () => {
      const text = copySource.textContent;
      let copied = false;

      if (
        typeof navigator !== 'undefined' &&
        typeof navigator.clipboard?.writeText === 'function'
      ) {
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch {
          copied = false;
        }
      }

      if (!copied) copied = copyWithFallback(text);
      copyStatus.textContent = copied
        ? 'Roadmap copied.'
        : 'Unable to copy roadmap.';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
