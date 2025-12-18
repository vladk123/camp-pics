import { redirectedFlash } from './redirectedFlash.js';
import { Token } from '../models/token.js';
import { sendEmail } from "./sendEmail.js";
import crypto from "crypto";

export const createNewUserVerify = async (req, res, next, userId, username) => {
    try {
        // Create new token for email verification
        const generatedCode = stringGen(60); //Generate verification code
        const email_verification_code = crypto.createHash("sha256").update(generatedCode).digest("hex"); //simple hash
        const user_id = userId //required for the token schema model
        const token = new Token({email_verification_code, user_id})
        await token.save()

        //send email
        // await sendEmail(undefined,username,"Please Verify Your Email - CampPics", "emails/users/verify_email.ejs", {req, generatedCode, req}, user_id)

        await sendEmail({
            to: username,
            subject: "Verify your account - CampPics",
            template: "verify-account",
            templateData: { generatedCode },
            userId
        });
        // console.log('sendEmail')
        return
        
    } catch (e) {
        if (e.name == "UserExistsError"){return redirectedFlash(req, res, 'error', "Hm, that email already exists...perhaps try 'Forgot Password' on the Login page.", '/') }
        next(e)
    }



}


function stringGen (length) {
    const generate = length => {
        var result           = '';
        var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        var charactersLength = characters.length;
        for ( var i = 0; i < length; i++ ) {
          result += characters.charAt(Math.floor(Math.random() * charactersLength));
        }
        return result
    }
    return generate(length)
}
