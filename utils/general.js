// Turn text to be slug-friendly
export const toSlug = (name) => {
    return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()                  // lowercase
    .trim()                         // remove leading/trailing spaces
    .replace(/[\s_]+/g, '-')        // replace spaces/underscores with hyphens
    .replace(/[^\w\-]+/g, '')       // remove all non-word chars except hyphen
    .replace(/\-\-+/g, '-')        // collapse multiple hyphens
    .replace(/^-+|-+$/g, ''); 
}

//generates string for generating random string to hash for user verification codes

export const stringGen = (length) => {
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
