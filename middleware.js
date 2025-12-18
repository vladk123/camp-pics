import rateLimiting from 'express-rate-limit' // For limiting how many requests made in a period of time
import speedLimiting from 'express-slow-down' // For limiting speed depending on how many requests made in a period of time
import mongoose from 'mongoose';
import { logger } from './utils/logging.js'
import { redirectedFlash } from './utils/redirectedFlash.js';

import multer from 'multer';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import cloudinary from './config/cloudinary.js';
import { URL } from 'url'

//////////TO DO / TD ///////////////

//////////CONNECTIONS///////////////
// // Check 
// export const checkMongoConnection = async (req, res, next) => {
//     if (mongoose.connection.readyState !== 1) {
//         // return res.status(503).json({ error: "Cannot connect to MongoDB database" });
//         // await logger(req, res, )
//         throw new Error ("Mongo Connection failed.")
//     }
//     next();
// };


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

///////////// REQUESTS/SECURITY /////////////
export const rateLimiter = (minutes) => {
    return(req, res, next) => {
        rateLimiting({
            windowMs: minutes * 60 * 1000, // 5 min
            max: 50, // Limit to 50 requests in the the windowMs time period
            message: 'Too many requests, please try again later.'
        })
        next()
    }
}
export const speedLimiter = (minutes) => {
    return(req, res, next) => {
        speedLimiting({
            windowMs: minutes * 60 * 1000, // 0.5 min
            delayAfter: 20, // Slow down after 20 requests in the windowMs time period
            delayMs: (hits) => hits * 1 * 1000, // Slow down request by an additional 1 second for each request after limit reached
        })
        next()
    }
}

// Wrapping async functions with replacement to not have to type "try" and "catch" for each one. Don't need to write "try" because async functions are already known to return promises
export const catchAsyncErrors = (fn) => {
    return (req, res, next) => { //doing this extra "parent" function because otherwise it will just return the result of the function instead of returning the function
        fn(req, res, next).catch(next);
    }
}


export const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB limit just in case
});


// ADMIN STUFF
export const isAdmin = (req, res, next) => {
    if(!req?.user?.isAdmin){
        return res.redirect('/')
    }
    next()
}