// LOGIN FORM
const loginDiv = document.getElementById('auth-modal')

const loginForm = loginDiv.querySelector('#login-form')
const registerForm = loginDiv.querySelector('#register-form')
const forgotPasswordForm = loginDiv.querySelector('#forgot-password-form')

// Listen for login/register "tab" switches
const loginToggleBtn = loginDiv.querySelector('#login-btn')
const registerToggleBtn = loginDiv.querySelector('#register-btn')
const forgotPasswordBtn = loginDiv.querySelector('#forgot-password-btn')

// Function to de-select login/register toggle selection and hide forms
const deselectLoginOptions = () => {
    loginToggleBtn?.classList.remove('selected')
    registerToggleBtn?.classList.remove('selected')

    loginForm?.classList.add('hidden')
    registerForm?.classList.add('hidden')
    forgotPasswordForm?.classList.add('hidden')
}

// If click on login
loginToggleBtn.addEventListener("click", () => {
    deselectLoginOptions()
    loginToggleBtn.classList.add('selected')
    loginForm.classList.remove('hidden')
});
// If click on register
registerToggleBtn.addEventListener("click", () => {
    deselectLoginOptions()
    registerToggleBtn.classList.add('selected')
    registerForm.classList.remove('hidden')
});
// If click on forgot password
forgotPasswordBtn.addEventListener("click", () => {
    deselectLoginOptions()
    forgotPasswordForm.classList.remove('hidden')
});


// OPEN LOGIN MODAL
const authModalParent = document.getElementById('auth-modal-parent')


// Btn from navbar to open login modal
const navOpenLoginModal = document.getElementById('nav-open-login-modal')
navOpenLoginModal?.addEventListener("click", () => {
  const modalDataset = 'login-modal';

  // Only guard against existing BACKDROP (not the modal element)
  const backdropExists = document.querySelector(`.modal-backdrop[data-modal-id="${modalDataset}"]`);
  // Or, additionally: if the modal is currently visible, skip
  const modalIsVisible = !authModalParent.classList.contains('hidden');

  if (backdropExists || modalIsVisible) {
    // Already open or has a live backdrop
    return;
  }

  createModalBackdrop(modalDataset);
  listenModalBackdrops();

  authModalParent.classList.remove('hidden');
  authModalParent.setAttribute('data-modal-id', modalDataset); // explicit
});


// Btn to logout
const navLogout = document.getElementById('nav-logout');
navLogout?.addEventListener('click', () => {
  const logoutForm = document.getElementById('logout-form')
  addReturnToField(logoutForm)
  logoutForm.submit();
});

// LOGIC TO HELP USER WITH USERNAME/PASSWORD CRITERIA + CONFIRM PASSWORD
document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const form = document.getElementById('register-form');
  const emailInput = document.getElementById('register-username');
  const fnameInput = document.getElementById('register-fname');
  const fnameFeedback = document.getElementById('register-fname-feedback');
  const emailFeedback = document.getElementById('register-email-feedback');
  const passwordInput = document.getElementById('register-password');
  const passwordFeedback = document.getElementById('register-password-feedback');
  const confirmInput = document.getElementById('register-password-confirm');
  const confirmFeedback = document.getElementById('register-confirm-feedback');
  const submitBtn = document.getElementById('register-submit');

  // Rules
  const ruleLength = document.getElementById('rule-length');
  const ruleUpper = document.getElementById('rule-upper');
  const ruleLower = document.getElementById('rule-lower');

  // Regex
  const emailRegex = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z]).{8,30}$/;

  // Flags
  let emailValid = false;
  let fnameValid = false;
  let passwordValid = false;
  let passwordsMatch = false;

  // --- EMAIL VALIDATION ---
  emailInput.addEventListener('input', () => {
    const value = emailInput.value.trim();
    if (value === '') {
      emailFeedback.textContent = '';
      emailFeedback.style.color = '#dc3545';
      emailValid = false;
    } else if (!emailRegex.test(value)) {
      emailFeedback.textContent = 'Invalid email format.';
      emailFeedback.style.color = '#dc3545';
      emailValid = false;
    } else if (value.includes('outlook') || value.includes('hotmail')) {
      emailFeedback.textContent = 'Please note that Outlook and Hotmail does not always receive our emails (for verifying accounts) - try using Gmail or another email if possible.';
      emailFeedback.style.color = '#dc3545';
      emailValid = false;
    } else {
      emailFeedback.textContent = 'Valid email.';
      emailFeedback.style.color = '#28a745';
      emailValid = true;
    }
  });

  // --- FIRST NAME VALIDATION ---
  fnameInput.addEventListener('input', () => {
    const value = fnameInput.value.trim();
    if (value === '') {
      fnameFeedback.textContent = 'This is what others may see if you upload media.';
      fnameFeedback.style.color = 'blue';
      fnameValid = false;
    } else if (value.length < 3 || value.length > 15) {
      fnameFeedback.textContent = 'Please fill 3-15 characters for the nickname - this is what others may see if you upload media.';
      fnameFeedback.style.color = '#dc3545';
      fnameValid = false;
    } else if (value.includes('admin') || value.includes('moderator')) {
      fnameFeedback.textContent = 'Please do not use "admin" or "moderator" in your username.';
      fnameFeedback.style.color = '#dc3545';
      fnameValid = false;
    } else {
      fnameFeedback.textContent = 'Valid nickname.';
      fnameFeedback.style.color = '#28a745';
      fnameValid = true;
    }
  });

  // --- PASSWORD VALIDATION ---
  passwordInput.addEventListener('input', () => {
    const val = passwordInput.value;

    ruleLength.className = val.length >= 8 && val.length <= 30 ? 'valid' : 'invalid';
    ruleUpper.className = /[A-Z]/.test(val) ? 'valid' : 'invalid';
    ruleLower.className = /[a-z]/.test(val) ? 'valid' : 'invalid';

    if (val === '') {
      passwordFeedback.textContent = '';
      passwordValid = false;
    } else if (passwordRegex.test(val)) {
      // passwordFeedback.textContent = 'Password looks good!';
      // passwordFeedback.style.color = '#28a745';
      passwordValid = true;
    } else {
      // passwordFeedback.textContent = 'Password does not meet all requirements.';
      // passwordFeedback.style.color = '#dc3545';
      // passwordValid = false;
    }

    checkPasswordsMatch();
  });

  // --- CONFIRM PASSWORD VALIDATION ---
  confirmInput.addEventListener('input', () => {
    checkPasswordsMatch();
  });

  function checkPasswordsMatch() {
    const val = passwordInput.value;
    const confirmVal = confirmInput.value;
    if (!confirmVal) {
      confirmFeedback.textContent = '';
      passwordsMatch = false;
    } else if (val !== confirmVal) {
      confirmFeedback.textContent = 'Passwords do not match.';
      confirmFeedback.style.color = '#dc3545';
      passwordsMatch = false;
    } else {
      confirmFeedback.textContent = 'Passwords match.';
      confirmFeedback.style.color = '#28a745';
      passwordsMatch = true;
    }
  }

  // --- FORM SUBMISSION CONTROL ---
  form.addEventListener('submit', (e) => {
    if (!emailValid || !passwordValid || !passwordsMatch || !fnameValid) {
      e.preventDefault(); // block actual submission
      e.stopPropagation();
      createFlashMsg('error', 'Please correctly fill out all required fields before submitting.', 'register-error', 10)
      return false;
    }

    // proceed with fetch('/user/register', ...) or allow natural form POST
  });

  // --- ENTER KEY SAFETY (redundant but ensures no rogue submits) ---
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (!emailValid || !passwordValid || !passwordsMatch || !fnameValid)) {
      e.preventDefault();
    }
  });
});


// Login form (on submission)
document.querySelector('#login-form').addEventListener('submit', e => {
  addReturnToField(e.target)
});

function addReturnToField (form) {
    // On submit, add a hidden "returnto" field so page goes back there
    const returnField = document.createElement('input');
    returnField.type = 'hidden';
    returnField.name = 'returnTo';
    returnField.value = window.location.pathname + window.location.search;
    form.appendChild(returnField);
}


// Close the login popup
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const openBackdrop = document.querySelector('#modal-backdrop-insert .modal-backdrop');
    if (!openBackdrop) return;
    const modalId = openBackdrop.getAttribute('data-modal-id');
    openBackdrop.remove();
    const modal = document.querySelector(`[data-modal-id="${modalId}"]`);
    modal?.classList.add('hidden');
    modal?.removeAttribute('data-modal-id');
  }
});
