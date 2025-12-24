import { User } from '../models/user.js';
import { Upload } from '../models/upload.js';
import { Park } from '../models/park.js';
import { Token } from '../models/token.js';
import { logger } from '../utils/logging.js'; //for logging errors
import crypto from 'crypto'
import { v2 as cloudinary } from 'cloudinary';
// import { getIP } from '../utils/getIP.js'
import { redirectedFlash } from '../utils/redirectedFlash.js';
import { createNewUserVerify } from '../utils/createNewUserVerify.js'
import { stringGen } from '../utils/general.js'
import { sendEmail } from "../utils/sendEmail.js";

// Minimum eight characters, at least one uppercase letter, one lowercase letter and one number
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z]).{8,30}$/;


export const register = async(req, res, next) => {
    const { username, password, fname, website_user, hands_check } = req.body

    // Honeypot check
    if (website_user) {
        console.warn('Bot registration attempt detected.');
        return res.status(400).send('No.');
    }

    // Other bot check
    const handsCheck = hands_check.trim().toLowerCase()
    if (handsCheck != '5' && handsCheck !='five') {
        console.warn('Bot registration attempt detected.');
        return res.status(400).send('No.');
    }

    if(username.length < 3 || username.length > 15 || username.includes('admin') || username.includes('moderator')){
        return redirectedFlash(req, res, 'error', `Oops! An error has occurred.`, '/')
    }

    // Verify password
    if (!passwordRegex.test(password)) {
        return redirectedFlash(req, res, 'error', `Oops! An error has occurred.`, '/')
    }

    // Proceed adding to DB
    let newUser 
    try {
        const user = new User({ username:username.toLowerCase().trim(), fname});

        // Store the IP
        user.ip_address_registered = res.locals.ip

        // Save new user
        newUser = await User.register(user, password)
        
        // Generate and email them the verification code
        await createNewUserVerify(req, res, next, user._id, user.username)

        return redirectedFlash(req, res, 'success', `Registered! Please check your inbox to verify your email (link expires soon!).`, '/',
            {GA4:{
                event: 'sign_up',
                user_id: newUser._id
            }}
        )
    } catch (err) {
        // console.error(err.errors)
        
        // Delete user if was created
        if(newUser){
            await User.findByIdAndDelete(newUser._id)
        }
        
        if(err?.name === 'UserExistsError'){
            return redirectedFlash(req, res, 'error', `User already exists.`, '/')
        } else {
            console.log(err)
            await logger(null,null,'error', {message: `User wasn't able to be created.`});
            return redirectedFlash(req, res, 'error', `Something went wrong when trying to register a new user...please contact us if this keeps happening: ${err?.name}`, '/')
        }
        
    }
}

export const login = async(req, res, next) => {
    try{
        // To store the IP
        // const realIp = await getIP(req)

        // If they're blocked, don't allow login
        if(req.user.blocked){
            req.logout();
            return redirectedFlash(req, res, 'error', 'An error occurred.', '/');
        }

        // If they've tried to login the 2nd time without verifying, it will not allow them any more.
        if (req.user.token_counter > 2) {
            let userId = req.user.username
            //get rid of existing token in db, if exists..?
            await Token.findOneAndDelete({user_id: req.user._id }) 
            req.logout();
            // errLogging(req, res, '', `Too many attempts by ${userId} to login without verifying account.`)
            throw new Error (`Something is not right, ${userId} - too many attempts to login without verifying this account. Please contact us to fix this issue.`)
        }
        
        // Update date last logged in (for tracking old inactive accounts during cleanup process) w/ IP to ensure not a bot that's changing IPs, and reset loginNoticeSent
        await User.findByIdAndUpdate(
            req.user._id,
            {
                $push: {
                    'other_login.previous_logins': {
                        $each: [{ timestamp: new Date(), ip_address: res.locals.ip }],
                        $sort: { timestamp: -1 }, // Keep the newest first
                        $slice: 20 // Allow only the last 20 entries
                    }
                },
                $set: {
                    loginNoticeSent: false,
                    'other_login.last_login': new Date(),
                    'other_login.reset_password_counter' : 0
                }
                
            }
        );

        //Checking if their user is verified
        let redirectUrl
        if(!req.user.email_verified) {
            redirectUrl = '/user/account';
        } else {
            // Return where they originally were
            redirectUrl = req.body.returnTo || '/';
        }

        return redirectedFlash(req, res, 'success', 'Logged In!', redirectUrl,
            {GA4:{
                event: 'login',
                user_id: newUser._id
            }}
        );
    } catch (err) {
        next()
    }

}

export const logout =  (req, res, next) => {
    const userId = req.user._id
    req.logout(async function (err){
        if(err) return next(err)
        req.session.regenerate((err => {
            if (err) return next(err);
            const redirectUrl = '/';
            redirectedFlash(req, res, 'success', 'Logged Out!', redirectUrl,
                {GA4:{
                    event: 'logout',
                    // user_id: userId // Cannot do this - otherwise it'll keep tracking this id, potentially causing compliance issues?
                    user_id: null // Better to clear it on log-out
                }}
            );
        }))
    });


}

export const verify =  async(req, res, next) => {
    const expiredLinkRedirect = () => redirectedFlash(req, res, 'error', 'Sorry, that link is invalid or has expired...please try re-verifying.', '/')
    try {
        // Check token
        const codeToCheck = crypto.createHash("sha256").update(req.params.code).digest("hex");
        const token = await Token.findOne({email_verification_code: codeToCheck});
        if(!token) {
            return expiredLinkRedirect()
        };
        const userId = token.user_id
        // If expired, delete and redirect
        if (token.email_verification_expiry < Date.now()) {
            await Token.findOneAndDelete({token})
            return expiredLinkRedirect()
        }
        // Check user and make sure token does not match
        const user = await User.findById(userId);
        if(!user || codeToCheck !== token.email_verification_code) {
            await Token.findOneAndDelete({ _id: token._id })
            return expiredLinkRedirect()
        // If token matches
        } else {
            await user.updateOne({$set: {email_verified: true}})
            await Token.findOneAndDelete({ _id: token._id })
            return redirectedFlash(req, res, 'success', 'Your account is verified and you can now sign in and upload photos and videos!', '/login',
                {GA4:{
                    event: 'user_verified',
                    method: 'email_verification_code',
                    // user_id: user._id
                }}
            )
        }
    } catch(e) {
        if (e.name == 'TypeError') {return expiredLinkRedirect()} 
        next(e)
    }

}


export const resendVerification = async(req, res, next) => {
    if(req.user.email_verified == false) {

        //increment the counter
        await User.findByIdAndUpdate({_id: req.user._id },{$inc: {token_counter: 1}})
        //delete current token
        await Token.findOneAndDelete({user_id: req.user._id })
        //send email again with verification link
        await createNewUserVerify(req, res, next, req.user._id, req.user.username)
        // req.logout();

        // When they're on their on their last allowed verification email
        if(req.user.token_counter == 2){
            return redirectedFlash(req, res, 'info', 'That was the last verification email sent! Contact us if you still did not receive it.', '/user/account',
                {GA4:{
                    event: 'new_verification_request',
                    user_id: req.user._id,
                }}
            )
        } else if (req.user.token_counter < 2){
            return redirectedFlash(req, res, 'info', 'You were just sent the verification email again - check your spam! Click the link in the email to verify.', '/user/account',
                {GA4:{
                    event: 'new_verification_request',
                    user_id: req.user._id,                    
                }}
            )
        } else {
            return redirectedFlash(req, res, 'error', 'You can no longer verify through the website; please contact us.', '/user/account')
        }
        
    }
}

// Clicked forgot password
export const forgotPassword = async(req, res, next) => {
    try{ 
        let username = req.body.forgot_username;
        //check username was filled out
        if(!username) {
            return redirectedFlash(req, res, 'error', 'Please fill out the email field.', '/')
        }
        username = username.toLowerCase();
        //get what the user account
        const user = await User.findOne({"username": username}).exec()

        // check if not 1 result, send bot false msg, in case someone trying to hack in
        if(!user){
            return redirectedFlash(req, res, 'success', 'If you have an account with us, you will receive an email shortly to reset your password.', '/')
        }

        // Increase counter
        if(typeof user.other_login.reset_password_counter !== "undefined" && user.other_login.reset_password_counter !== ""){
            user.other_login.reset_password_counter ++
        } else {
            user.other_login.reset_password_counter = 1
        }

        // If reset password too many times...without actually resetting it
        if(user.other_login.reset_password_counter > 3){
            return redirectedFlash(req, res, 'error', "You have attempted resetting your password too many times. Please contact us.", '/')
        }
      
        //generate random code 15-characters long
        const code = stringGen(15)
        //hash the code
        const hashedCode = crypto.createHash("sha256").update(code).digest("hex"); //simple hash

        // set the reset_password_code 
        user.other_login.reset_password_code = hashedCode
        user.other_login.reset_password_expiry = Date.now() + 15*60*1000 

        await user.save()

        // userId to pass to the email
        const userId = user._id
        // send user email with link
        await sendEmail({
            to: user.username,
            subject: "Your Password Reset Link - CampPics",
            template: "reset-password",
            templateData: {code, userId},
            userId,
        })

        return redirectedFlash(req, res, 'success', 'Please check your email inbox (and spam) and click the link to reset your password.', '/',
            {GA4:{
                event: 'reset_password_request',
                // user_id: req.user._id,
            }}
        )
    } catch (e) {
        next(e)
    }
}

// Clicked the reset link in email after clicking Forgot Password on website
export const renderForgotPasswordReset = async(req, res, next) => {
    try{ 
        // Log the user out & redirect
        const {userId, code} = req.params;
        if(!userId || !code){
            return redirectedFlash(req, res, 'error', 'Hm, are you sure you clicked the correct link?', '/')
        }
        req.logout(() => {
            return res.render(
                'user/forgotPassword', 
                {
                    meta: {
                        title: 'Reset Password', 
                    }, 
                    userId, 
                    code, 
                    data:{}
                }
            ) // data obj to avoid crashes
        });
        
    } catch (e) {
        next(e)
    }
}

// User submitted to reset forgotten password
export const updateForgotPasswordReset = async(req, res, next) => {
    try{ 
        const {userId, code} = req.params;
        const { new_password } = req.body;
        if(!userId || !code || !new_password){
            return redirectedFlash(req, res, 'error', 'Hm, are you sure you clicked the correct link and filled all the fields?', '/')
        }
        // Verify password
        if (!passwordRegex.test(new_password)) {
            return redirectedFlash(req, res, 'error', `Oops! An error has occurred.`, '/')
        }

        //Get user (by param since not logged in)
        const user = await User.findById(req.userId)

        // If user not found
        if (!user) {
            return redirectedFlash(req, res, 'error', `Oops! An error has occurred.`, '/')
        }

        // Check code to make sure it matches
        const hashedCode = crypto.createHash("sha256").update(code).digest("hex"); //simple hash

        // If password reset code doesn't match what it should be
        if(hashedCode != user?.other_login?.reset_password_code){
            return redirectedFlash(req, res, 'error', 'Something went wrong. Please ensure your passwords match and that you clicked the correct email link.', '/')
        }

        // Update user
        try { // <- seems without nested try/catch, it does not catch errors for this level of code?
            // Attempt to set new password
            user.setPassword(new_password, function(setPasswordErr, user) {
                if (setPasswordErr) { return redirectedFlash(req, res, 'error', setPasswordErr, '/'); }
                user.save(function(saveErr) {
                    if (saveErr) { return redirectedFlash(req, res, 'error', saveErr, '/'); }
                    return redirectedFlash(req, res, 'success', 'Password Updated! You can log in with your new password.', '/')
                });
            });      
        } catch(e) {
            return redirectedFlash(req, res, 'error', e.message, '/')
        }

        return res.render(
            'user/forgotPassword', 
            {
                meta: {
                    title: 'Reset Password', 
                }, 
                userId, 
                code, 
                data:{}
            }
        ) // data obj to avoid crashes
    } catch (e) {
        next(e)
    }
}

// Filled out the "reset password" form on the account page
export const changePassword = async(req, res, next) => {
    try{ //even though we have the .catch middleware for this async function, here we're checking for errors within the passport submission
        const {original_password, new_password, new_password_repeat} = req.body;

        //check if exists
        if(!original_password || !new_password) {
            return redirectedFlash(req, res, 'error', 'Please fill out all password fields.', '/user/account')
        }
        
        // Verify password
        if (!passwordRegex.test(new_password)) {
            return redirectedFlash(req, res, 'error', `Invalid password per the requirements (8-30 characters, at least one uppercase letter, one lowercase letter and one number).`, '/user/account')
        }

        //checking that passwords match
        if (new_password_repeat !== new_password) { 
            return redirectedFlash(req, res, 'error', 'Passwords do not match! Make sure you type your password correctly!', '/user/account')
        } else {
            //get what the details should be
            const user = await User.findById(req.user.id)

            //update user
            try { // <- seems without nested try/catch, it does not catch errors for this level of code?
                // checking that current password is correct
                await new Promise((resolve, reject) => {
                    user.authenticate(original_password, (err, authenticated) => {
                      if (err) return reject(err);
                      if (!authenticated)
                        return reject(new Error('Current password does not seem to be correct.'));
                  
                        user.setPassword(new_password, async (setErr) => {
                            if (setErr) return reject(setErr);
                            try {
                                await user.save(); // ✅ no callback
                                resolve();
                            } catch (saveErr) {
                                reject(saveErr);
                            }
                        });
                    });
                });                  
                  
                  return redirectedFlash(req, res, 'success', 'Password updated successfully!', '/user/account');
                  
            } catch(e) {
                return redirectedFlash(req, res, 'error', e.message, '/user/account')
            }
        }
    } catch (e) {
        next(e)
    }
}


export const getAccount = (req, res, next) => {
    return res.render(
        'user/account', 
        {
            meta: {
				title: 'Account', 
			}, 
            data: { currentPath: req.originalUrl }
        }
    ); // data obj to avoid crashes
}



export const deleteAccount = async (req, res, next) => {
  try {
    const userId = req.user._id;

    // Find all uploads belonging to this user
    const uploads = await Upload.find({ userId });

    // Delete each photo from Cloudinary if applicable
    const cloudDeletes = uploads
      .filter(up => up.mediaType === 'photo' && up.cloudinaryId)
      .map(up =>
        cloudinary.uploader.destroy(up.cloudinaryId).catch(() => null)
      );

    await Promise.all(cloudDeletes);

    // Delete uploaded media from Park model
    const parks = await Park.find({
      $or: [
        { 'photos.user': userId },
        { 'videos.user': userId },
        { 'campgrounds.campsites.photos.user': userId },
        { 'campgrounds.campsites.videos.user': userId }
      ]
    });

    for (const park of parks) {
      // Remove park-level media
      park.photos = park.photos.filter(p => !p.user.equals(userId));
      park.videos = park.videos.filter(v => !v.user.equals(userId));

      // Remove campground/campsite-level media
      for (const cg of park.campgrounds) {
        for (const cs of cg.campsites) {
          cs.photos = cs.photos.filter(p => !p.user.equals(userId));
          cs.videos = cs.videos.filter(v => !v.user.equals(userId));
        }
      }

      await park.save();
    }

    // Delete Upload records
    await Upload.deleteMany({ userId });

    //Delete the User account itself
    await User.findByIdAndDelete(userId);

    // Log the user out & redirect
    req.logout(() => {
        return redirectedFlash(req, res, 'success', 'Account deleted!', '/',
            {GA4:{
                event: 'delete_account',
                user_id: null,
            }}
        );
    });

  } catch (err) {
    next(err);
  }
};
