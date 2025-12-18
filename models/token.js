// Keep track of all registration tokens

import mongoose from 'mongoose';
const Schema = mongoose.Schema;
await import('dotenv/config');

const tokenSchema = new Schema({
    email_verification_code: {
        type: String,
        required: true
    },
    user_id: { 
        type: Schema.Types.ObjectId, 
        ref: "User", required: true 
    },
    email_verification_expiry: {
        type: Date,
        default: () => Date.now() + 12*60*60*1000 //12 hours from now
    },

    date: {
        type: Date,
        default: Date.now()
    },
});

export const Token = mongoose.model('Token', tokenSchema);