import { sendEmail } from "../utils/sendEmail.js";
await import('dotenv/config')
import { redirectedFlash } from '../utils/redirectedFlash.js';

export const renderFaq = async (req, res, next) => {
    return res.render(
        'other/faq', 
        {
            meta: {
				title: 'FAQ', 
				description: `Frequently asked questions for CampPics.`,
				url: `${process.env.CC_DOMAIN}/other/faq`,
                image: `https://camppics.ca/images/images/home-hero-winter.jpg`,
			}, 
            data: { currentPath: req.originalUrl }
        }

    ); // data obj to avoid crashes
};

export const renderContact = async (req, res, next) => {
    try {
        return res.render('other/contact', {
            meta: {
				title: 'Contact', 
				description: `Have questions, concerns or a suggestion for CampPics? Either way, happy to hear from a fellow camper!`,
				url: `${process.env.CC_DOMAIN}/other/contact`,
                image: `https://camppics.ca/images/images/home-hero-winter.jpg`,
			},
            currentUser: req.user || null,
            prefill: req.query || {},
            data:{ currentPath: req.originalUrl } // data obj to avoid crashes
        });
    } catch (err) {
        next(err);
    }
};


export const submitContactForm = async (req, res, next) => {
    try{
        const {fname, email, email_subject, email_body, confirm_question} = req.body
        // if did not fill out one of the fields
        if(typeof fname == 'undefined' || typeof email == 'undefined' || typeof email_subject == 'undefined' || typeof email_body == 'undefined' || typeof confirm_question == 'undefined'){
            return redirectedFlash(req, res, 'error', 'It seems like you have missed a field. Please try again.', '/other/contact')
        }
        
        // If answered left hand question incorrectly
        const confirmQuestion = confirm_question.trim().toLowerCase()
        if(confirmQuestion !== 'one' && confirmQuestion !== '1'){
            return redirectedFlash(req, res, 'success', 'Message sent, thanks for reaching out!', '/other/contact')
        }
        
        // email admin
        await sendEmail({
            to: process.env.ADMIN_EMAIL,
            subject: "Form Submission - CampPics",
            template: "email-contact-form-submission",
            templateData: {fname, email, email_subject, email_body},
            userId: req?.user?._id,
        })

        // console.log('sendEmail')
        return redirectedFlash(req, res, 'success', 'Message sent, thanks for reaching out! We will try our best to get back to you within a few business days.', '/')
    } catch (e) {
        next(e)
    }
};


export const renderPrivacyAndTerms = async (req, res, next) => {
    try {
        return res.render('other/privacy-and-terms', {
            meta: {
				title: 'Terms and Privacy', 
				description: `Terms of use and privacy policy for CampPics.`,
				url: `${process.env.CC_DOMAIN}/other/privacy-and-terms`,
                image: `https://camppics.ca/images/images/home-hero-winter.jpg`,
			},
            data:{ currentPath: req.originalUrl } // data obj to avoid crashes
        });
    } catch (err) {
        next(err);
    }
};