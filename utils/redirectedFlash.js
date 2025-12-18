// Functions that are used throughout the app
import flash from 'connect-flash';
import { logger } from "./logging.js";

export const redirectedFlash = async(req, res, msgType='info', msg, oldRedirectTo='/', openLogin=false) => {
    let redirectTo = oldRedirectTo
    let loginParam = ""

    // Check message type is correct. If not, default to info
    if(!(msgType == 'info' || msgType == 'error' || msgType == 'warning' || msgType == 'success')){
        msgType = 'info'
    }

    // Escape backslashes to avoid errors
    msg = await msg.replace(/\\/g, "\\\\"); // Replaces single `\` with `\\`

    // If need to open up login modal and that param doesn't already exist
    if (openLogin == true && !redirectTo.includes("login=")) { 
        loginParam = "?login=true" 
    } else {
        redirectTo = oldRedirectTo.replace('?login=true','')
    }
    // console.log(msg)
    req.flash(msgType, msg);

    // As long as the "go back to" URL isn't Login or the Logout route
    // Double check that not already redirected (to avoid error that headers already sent)
    if (!res.headersSent) {
        // Old <- flash messages didn't always show
        // if(redirectTo !== "/login" && redirectTo !== "/logout") { 
        //     return res.redirect(redirectTo + loginParam || '/' + loginParam) 
        // } else {
        //     return res.redirect('/' + loginParam)
        // }

        // Ensure flash is persisted before redirect by saving to the user's session
        req.session.save(err => {
            if (err) console.error('Session save error before redirect:', err);

            if (redirectTo !== '/login' && redirectTo !== '/logout') {
                return res.redirect(redirectTo + loginParam || '/' + loginParam);
            } else {
                return res.redirect('/' + loginParam);
            }
        });
    } else {
        await logger(req, res, 'error', {message:`Trying to send user to the following url, but headers already sent: ${redirectTo}`})
        return
    }
    
}

