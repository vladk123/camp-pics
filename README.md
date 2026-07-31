# [CampPics.ca](https://camppics.ca)
## How to Upload
1. Create an account.
2. Verify your account (you'll receive an email after registering).
3. Find a park and upload:
    - Park images and video
    - Campsite-specific images and video

## Viewing Parks
- No account needed, just find the provincial, territorial, or federal park that you're seeking!

## MongoDB deployment requirement

New photo and video creation uses MongoDB transactions so the embedded Park
media, Upload record, and User upload history commit together. Production must
therefore use a transaction-capable replica set or sharded MongoDB deployment.
A deployment without transaction support fails new media creation safely; for
photos, any newly prepared Cloudinary assets are cleaned up before the failure
response is returned.
