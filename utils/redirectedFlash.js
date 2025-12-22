// Functions that are used throughout the app
import flash from 'connect-flash';
import { logger } from "./logging.js";

export const redirectedFlash = async(req, res, msgType='info', msg, oldRedirectTo='/', data = {}) => {
    let redirectTo = oldRedirectTo
    let loginParam = ""

    // Persist GA event data for next request only
    if (data?.GA4) {
        req.session.__GA4_EVENT__ = data.GA4;
    }

    // Check message type is correct. If not, default to info
    if(!(msgType == 'info' || msgType == 'error' || msgType == 'warning' || msgType == 'success')){
        msgType = 'info'
    }

    // Escape backslashes to avoid errors
    msg = await msg.replace(/\\/g, "\\\\"); // Replaces single `\` with `\\`

    req.flash(msgType, msg);

    // As long as the "go back to" URL isn't Login or the Logout route
    // Double check that not already redirected (to avoid error that headers already sent)
    if (!res.headersSent) {

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

