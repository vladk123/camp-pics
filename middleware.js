import { redirectedFlash } from './utils/redirectedFlash.js';
import { sessionAuthVersionMatches } from './utils/authLifecycle.js';

import multer from 'multer';

//////////TO DO / TD ///////////////

//////////CONNECTIONS///////////////
///////// AUTH /////////////

// 
export const usernameToLowerCaseAndTrim = (req, res, next) => {
    if(typeof req.body.username === "undefined" || !req.body.username){
        return redirectedFlash(req, res, 'error', `Oops! An error has occurred: ${'Where is the username?'}`, '/')
    }
    req.body.username = req.body.username.toLowerCase().trim();
    next()
}

// Check if logged in
export const isLoggedIn = async (req, res, next) => {
    if(!req.isAuthenticated()){ //using passport npm package - checking if logged out
        req.session.returnTo = req.originalUrl; 
        return redirectedFlash(req, res, 'error', `Please log in first!`, '/')
    } 

    // Check if blocked
    if (req.user?.blocked) {
        // Properly handle logout with callback
        return req.logout(err => {
            if (err) return next(err);
            return redirectedFlash(req, res, 'error', 'Hmm...an error has occurred.', '/');
        });
    }
    
    // If not verified, redirect to their account page, assuming they're not already going there
    if(!req.user.email_verified && !req.originalUrl.includes('/user/account')){
        return redirectedFlash(req, res, 'error', 'Your account email has not been verified. Click the button below to verify to receive the verification link (check your spam too).', '/user/account')
    }

    next();
}

// Check authentication without requiring email verification.
export const isAuthenticatedForVerification = (req, res, next) => {
    if (!req.isAuthenticated()) {
        req.session.returnTo = req.originalUrl;
        return redirectedFlash(req, res, 'error', 'Please log in first!', '/');
    }

    if (req.user?.blocked) {
        return req.logout(err => {
            if (err) return next(err);
            delete req.session.auth_version;
            return redirectedFlash(req, res, 'error', 'Hmm...an error has occurred.', '/');
        });
    }

    next();
};

export const enforceSessionAuthVersion = (req, res, next) => {
    if (!req.user || !req.isAuthenticated()) {
        return next();
    }

    if (sessionAuthVersionMatches(req.session?.auth_version, req.user.auth_version)) {
        return next();
    }

    return req.logout(err => {
        if (err) return next(err);
        if (req.session) {
            delete req.session.auth_version;
        }
        return next();
    });
};

// API check if logged in
export const isLoggedInAPI = (req, res, next) => {
    if(!req.isAuthenticated()){ 
        return res.status(401).json('Please log in.')
    } 

    // Check if blocked
    if (req.user?.blocked) {
        // Properly handle logout with callback
        return req.logout(err => {
            if (err) return next(err);
            return redirectedFlash(req, res, 'error', 'Hmm...an error has occurred.', '/');
        });
    }

    // If email and mobile are both not yet verified
    if(!req.user.verification.email.verified) {
        return res.status(401).json('User unverified.')
    }

    next();
}

// Check if logged out
export const isLoggedOut = (req, res, next) => {
    // Use for not allowing them to register or login in again while logged in
    if(req.isAuthenticated()){ //using passport npm package - checking if logged in
        req.session.returnTo = req.originalUrl;
        return redirectedFlash(req, res, 'error', `You have to be logged out to do that.`, '/')
    } else {
        next();
    }
}

// Check if photo owner

///////////// SUBMISSIONS /////////////

// Do not allow double-submission

// Sanitize input

// Wrapping async functions with replacement to not have to type "try" and "catch" for each one. Don't need to write "try" because async functions are already known to return promises
export const catchAsyncErrors = (fn) => {
    return (req, res, next) => { //doing this extra "parent" function because otherwise it will just return the result of the function instead of returning the function
        fn(req, res, next).catch(next);
    }
}


const MAX_PHOTO_FILES = 5;
const MAX_PHOTO_FIELDS = 4;
const MAX_ACCEPTED_PHOTO_PARTS = MAX_PHOTO_FILES + MAX_PHOTO_FIELDS;

const PHOTO_UPLOAD_LIMITS = Object.freeze({
  fileSize: 10 * 1024 * 1024,
  files: MAX_PHOTO_FILES,
  fields: MAX_PHOTO_FIELDS,

  // Busboy emits partsLimit when its counter reaches this threshold.
  // Use accepted application parts + 1 so nine parts succeed and
  // the tenth is rejected.
  parts: MAX_ACCEPTED_PHOTO_PARTS + 1,

  fieldNestingDepth: 0,
});

export const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: PHOTO_UPLOAD_LIMITS,
});


// ADMIN STUFF
export const isAdmin = (req, res, next) => {
    if(!req?.user?.isAdmin){
        return res.redirect('/')
    }
    next()
}
