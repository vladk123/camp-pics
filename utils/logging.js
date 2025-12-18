// type: 'error', 'success', 'general', 'unknown'
// otherDetails must be object:
    // 'message'
    // 'severity: (1 = mild, 2 = med, 3 = severe)')
    // whatever the data is?
export const logger = (req=null, res=null, type, otherDetails=null) => { 
    return new Promise((resolve, reject) => {
        try {
            // randomFunction()
            (async() => { // Can't set the new Promise function as async because it's anti-pattern?
                if(typeof otherDetails === 'object' || !otherDetails){
                    if(type == 'error'){
                        // If there's a logged-in user, input that too
                        if(req?.user){
                            otherDetails.user = req.user
                        }
                        // console.log('logging.js, line 17:')
                        console.error(otherDetails)
                        // await logInfoToDB(otherDetails)
                        // Break down the error?
                        console.error(otherDetails.error)
                        // If has severity 
                        if(!otherDetails.severity || otherDetails.severity > 1){
                            // Email admin
                            try {
                                // console.log('about to email admin')
                                // await emailAdmin(otherDetails)
                                // console.log('after emailed admin')
                            } catch (err) {
                                // console.error(err)
                            }
                        }
                        if(!otherDetails.severity || otherDetails.severity > 2) {
                            // Text admin
                            try {
                                // console.log('about to text admin')
                                // await textAdmin()
                                // console.log('after texted admin')
                            } catch (err) {
                                console.error(err)
                            }   
                        }
                    } else if (type === 'success'){
                        // await logInfoToDB()
                        console.log(type, otherDetails)
                    } else if (type === 'general'){
                        // await logInfoToDB()
                        console.log(type, otherDetails)
                    } else if (type === 'unknown'){
                        // await logInfoToDB(otherDetails)
                        console.log(type, otherDetails)
                    }
                    
                }
            })()
            resolve()
        } catch (err) {
            console.error('//////////////////////////////////////')
            console.error('Caught error in logging.js:')
            console.error('...........................')
            console.error(err)
            console.error('ORIGINAL LOG:')
            console.error('Log type:', type)
            console.error('Other details:', otherDetails)
            console.error('Throwing error now from logging.js.')
            console.error('//////////////////////////////////////')
            resolve()  // Resolving so code can continue (this is not code-breaking)
            // reject() <- cannot do this or it'll be an infinite loop
            throw new Error('Logger Error:', err)
        }
    })
    
}