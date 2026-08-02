(function bindForgotPasswordForm() {
  'use strict';

  const form = document.getElementById('resetForm');
  const passwordInput = document.getElementById('new_password');
  const confirmationInput = document.getElementById('new_password_repeat');
  const passwordPolicy = window.CampPicsPasswordPolicy;

  if (
    !form ||
    !passwordInput ||
    !confirmationInput ||
    typeof passwordPolicy?.bindPasswordForm !== 'function' ||
    form.dataset.passwordPolicyBound === 'true'
  ) {
    return;
  }

  form.dataset.passwordPolicyBound = 'true';
  passwordPolicy.bindPasswordForm({
    form,
    passwordInput,
    confirmationInput,
  });
})();
