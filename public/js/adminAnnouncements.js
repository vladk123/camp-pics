(function initializeAdminAnnouncementsScript() {
  'use strict';

  let initialized = false;

  function initialize() {
    if (initialized) return;
    initialized = true;

    const form = document.getElementById('admin-announcement-form');
    if (!form) return;

    const enabled = document.getElementById('announcement-enabled');
    const title = document.getElementById('announcement-title');
    const message = document.getElementById('announcement-message');
    const autoOpen = document.getElementById('announcement-auto-open');
    const showNav = document.getElementById('announcement-show-nav');
    const navText = document.getElementById('announcement-nav-text');
    const navTextField = document.getElementById('announcement-nav-text-field');
    const ctaLabel = document.getElementById('announcement-cta-label');
    const ctaUrl = document.getElementById('announcement-cta-url');
    const previewTitle = document.getElementById('announcement-preview-heading');
    const previewMessage = document.getElementById('announcement-message-preview');
    const previewNav = document.getElementById('announcement-nav-preview');
    const previewNavText = document.getElementById('announcement-nav-preview-text');
    const previewCta = document.getElementById('announcement-cta-preview');

    const requiredElements = [
      enabled,
      title,
      message,
      autoOpen,
      showNav,
      navText,
      navTextField,
      ctaLabel,
      ctaUrl,
      previewTitle,
      previewMessage,
      previewNav,
      previewNavText,
      previewCta,
    ];
    if (requiredElements.some(element => !element)) return;

    function updatePreview() {
      previewTitle.textContent = title.value.trim() || 'Announcement title';
      previewMessage.textContent = message.value || 'Your announcement message appears here.';
      previewNavText.textContent = navText.value.trim() || 'Announcement';
      previewCta.textContent = ctaLabel.value.trim() || 'Learn more';

      navTextField.hidden = !showNav.checked;
      previewNav.hidden = !showNav.checked;
      previewCta.hidden = !(ctaLabel.value.trim() && ctaUrl.value.trim());
      form.dataset.previewEnabled = enabled.checked ? 'true' : 'false';
      form.dataset.previewAutoOpen = autoOpen.checked ? 'true' : 'false';
    }

    previewCta.addEventListener('click', event => event.preventDefault());
    for (const control of [
      enabled,
      title,
      message,
      autoOpen,
      showNav,
      navText,
      ctaLabel,
      ctaUrl,
    ]) {
      control.addEventListener('input', updatePreview);
      control.addEventListener('change', updatePreview);
    }
    updatePreview();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
