(function () {
  const POLICY_MESSAGE =
    'Password must be 8-30 characters and include at least one uppercase letter, one lowercase letter, and one number.';
  const CONFIRMATION_MESSAGE = 'Passwords do not match.';

  const isValidPassword = password =>
    typeof password === 'string' &&
    password.length >= 8 &&
    password.length <= 30 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /\d/.test(password);

  const passwordsMatch = (password, confirmation) =>
    typeof password === 'string' &&
    typeof confirmation === 'string' &&
    password === confirmation;

  const setRuleState = (element, valid) => {
    if (element) {
      element.className = valid ? 'valid' : 'invalid';
    }
  };

  const updateRules = (password, rules = {}) => {
    setRuleState(
      rules.length,
      password.length >= 8 && password.length <= 30,
    );
    setRuleState(rules.uppercase, /[A-Z]/.test(password));
    setRuleState(rules.lowercase, /[a-z]/.test(password));
    setRuleState(rules.number, /\d/.test(password));
  };

  const bindPasswordForm = ({
    form,
    passwordInput,
    confirmationInput,
    rules,
    onInvalid,
  }) => {
    if (!form || !passwordInput || !confirmationInput) {
      return null;
    }

    const validate = () => {
      const passwordValid = isValidPassword(passwordInput.value);
      const confirmationValid = passwordsMatch(
        passwordInput.value,
        confirmationInput.value,
      );

      updateRules(passwordInput.value, rules);
      passwordInput.setCustomValidity(
        passwordValid ? '' : POLICY_MESSAGE,
      );
      confirmationInput.setCustomValidity(
        confirmationValid ? '' : CONFIRMATION_MESSAGE,
      );

      return passwordValid && confirmationValid;
    };

    passwordInput.addEventListener('input', validate);
    confirmationInput.addEventListener('input', validate);
    form.addEventListener('submit', event => {
      if (!validate()) {
        event.preventDefault();
        if (typeof onInvalid === 'function') {
          onInvalid();
        }
      }
    });

    return { validate };
  };

  window.CampPicsPasswordPolicy = Object.freeze({
    CONFIRMATION_MESSAGE,
    POLICY_MESSAGE,
    bindPasswordForm,
    isValidPassword,
    passwordsMatch,
    updateRules,
  });
})();
