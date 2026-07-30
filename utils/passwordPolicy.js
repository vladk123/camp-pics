export const PASSWORD_POLICY_MESSAGE =
    'Password must be 8-30 characters and include at least one uppercase letter, one lowercase letter, and one number.';

export const PASSWORD_CONFIRMATION_MESSAGE = 'Passwords do not match.';

export const isPasswordAllowed = password =>
    typeof password === 'string' &&
    password.length >= 8 &&
    password.length <= 30 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /\d/.test(password);

export const validatePassword = (password, confirmation) => {
    if (!isPasswordAllowed(password)) {
        return {
            valid: false,
            message: PASSWORD_POLICY_MESSAGE,
        };
    }

    if (confirmation !== undefined && password !== confirmation) {
        return {
            valid: false,
            message: PASSWORD_CONFIRMATION_MESSAGE,
        };
    }

    return {
        valid: true,
        message: null,
    };
};
