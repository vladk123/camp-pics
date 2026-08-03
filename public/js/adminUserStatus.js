(function initializeAdminUserStatusForms() {
  'use strict';

  document.addEventListener('submit', event => {
    const form = event.target.closest?.('.user-status-form');
    if (!form) return;

    const action = form.dataset.action === 'unblock' ? 'Unblock' : 'Block';
    if (!window.confirm(`${action} this user?`)) event.preventDefault();
  });
})();
