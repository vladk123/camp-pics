import mongoose from 'mongoose';
const Schema = mongoose.Schema;
import passportLocalMongoose from 'passport-local-mongoose';
await import('dotenv/config');
import bcrypt from 'bcryptjs';

const UserSchema = new Schema({
    // For all users
    date_created:{
        type: Date,
        default: Date.now()
    },
    isAdmin: {
        type: Boolean,
        default: false
    },
    blocked: {
        type: Boolean,
        default: false
    },
    token_counter: { // Number of times user validation email was sent to them
        type: Number,
        default: 0
    },
    email_verified: {
        type: Boolean,
        default: false
    },
    fname: { // Nickname
        type: String,
        required: true,
        maxLength: 15
    },
    // lname: {
    //     type: String, 
    //     maxLength: 500
    // },
    trusted: {
        type: Boolean,
        default: false
    },
    username: { // Email
		type: String,
		required: true,
		unique: true,
        maxLength: 50,
        validate: {
            validator: function(v) {
                return /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/.test(v);
            },
            message: "Please enter a valid email"
        },
	},
    // mobile_number: String,
    ip_address_registered: String,
    uploads: [
        {
            mediaType: { type: String, enum: ['photo', 'video'], required: true },

            mediaId: { type: mongoose.Schema.Types.ObjectId, required: true }, 
            // The _id inside park.photos[] or park.videos[]

            cloudinaryUrl: String,       // for photos
            youtubeUrl: String,          // for videos

            parkId: { type: mongoose.Schema.Types.ObjectId, required: true },
            parkSlug: String,
            parkName: String,

            campgroundId: mongoose.Schema.Types.ObjectId,
            campgroundSlug: String,
            campgroundName: String,

            campsiteId: mongoose.Schema.Types.ObjectId,
            campsiteSlug: String,
            campsiteName: String,

            caption: String,
            dateTaken: Date,
            uploadedAt: { type: Date, default: Date.now },

            // Helpful later if you add moderation features:
            status: { type: String, enum: ['active', 'removed'], default: 'active' }
        }
    ],


 
    other_login: {
        // Passwords
        reset_password_code: String,
        reset_password_expiry: {
            type: Date,
            default: () => Date.now() + 15*60*1000 // 15 min from now
        },
        reset_password_counter: {
            type: Number,
            default: 0
        }, //number of times user has attempted or has reset password

        // Keeping track of this to delete old accounts
        last_login: { // TEMP: used to be lastLoggedIn
            type: Date,
            default: Date.now(),
        },
        // Keep track of last ____ times that the user has logged in
        previous_logins:[
            {
                timestamp: Date,
                ip_address: String,
            }
        ],
        // Inform user to log back in -> make this an array to store records
        login_notice_sent: { // TEMP: used to be loginNoticeSent
            type: Boolean,
        },
        
    },

})

// plugin for passport-local-mongoose - it handles username and password by default (so we have no password field above), and hashes it
// ...we also set up some options so people get temporarily logged out after entering the wrong details
UserSchema.plugin(passportLocalMongoose, {
    limitAttempts: true, //specifies whether login attempts should be limited and login failures should be penalized.
    maxAttempts: 5, //specifies the maximum number of failed attempts allowed before preventing login. Default: Infinity.
    maxInterval: 60000, //specifies the maximum amount of time an account can be locked (max 10 min)
    interval: 5000, //specifies the interval in milliseconds between login attempts, which increases exponentially based on the number of failed attempts, up to maxInterval (above)
});

// module.exports = mongoose.model('User', UserSchema);
export const User = mongoose.model('User', UserSchema);
// export default User;