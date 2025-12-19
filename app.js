import { logger } from './utils/logging.js'; //for logging errors

// If in dev mode, use dotenv package to access .env variables
if(process.env.NODE_ENV === "development"){ 
	logger(null,null,'general', {message: 'Dev mode!'});
	await import('dotenv/config')
	logger(null,null,'general', {message: 'dotenv loaded in development mode'});
}

import express from 'express';
const app = express();
app.set('trust proxy', 1) // Since on Heroku/Digital Ocean (behind proxy), telling Express to trust proxy before using req.ip
import path from 'path'; //so we can set views directory below
import { fileURLToPath } from 'url';
import ejsMate from 'ejs-mate'; //engine used to parse EJS
import session from 'express-session'; //helps us with user sessions like cookies but more data - logged in? shopping cart, etc
import mongoose from 'mongoose';
import MongoStore from 'connect-mongo';
import { User } from './models/user.js'; //requiring the User schema, for passport npm 
import passport from 'passport';//plugin that allows us to easily authenticate
import LocalStrategy from 'passport-local'; //using local strategy i.e., not FB or Twitter login, etc

import compression from 'compression'
app.use(compression())
import methodOverride from 'method-override';
import cookieParser from 'cookie-parser';
import csrf from 'csurf';
import helmet from 'helmet'
import rateLimiting from 'express-rate-limit' // For limiting how many requests made in a period of time
import speedLimiting from 'express-slow-down' // For limiting speed depending on how many requests made in a period of time
import { getIP } from './utils/getIP.js'
import { initializeParkSearchCache } from './utils/cacheSearch.js';

import flash from 'connect-flash';
import { redirectedFlash } from './utils/redirectedFlash.js';

// Doing overall limiting on all requests
const rateLimiterLong = rateLimiting({
	windowMs: 5 * 60 * 1000, // 5 min
	max: 100, // Limit to 100 requests in the the windowMs time period
	message: 'Too many requests, please try again later.'
})
const speedLimiterLong = speedLimiting({
	windowMs: 1 * 60 * 1000, // 1 min
	delayAfter: 50, // Slow down after 50 requests in the windowMs time period
	delayMs: (hits) => hits * 1 * 1000, // Slow down request by an additional 1 second for each request after limit reached
})
// Skip rate limiting if loading public files
app.use(['/public', '/favicon.ico'], (req, res, next) => next())
// app.use(rateLimiterLong)
// app.use(speedLimiterLong)

//TO USE ON EVERY ROUTE
app.engine('ejs', ejsMate); //telling app to use this engine instead of default one
app.set('view engine', 'ejs'); //per the ejs docs
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.set('views', path.join(__dirname,'views')); //making sure "views" folder is relative to this file
app.use(express.urlencoded({ extended: true, limit: '10kb' })); //express's parser so that we can pass data from forms into db
app.use(express.json({limit: '10kb'})) // To parse the incoming requests with JSON payloads (found on SOF) - useful when passing data from fetch to route to use when POSTing
app.use(express.static(path.join(__dirname, 'public'))); //telling it to serve "public" directory (the public folder we created).

// If in production, check that it's on https (otherwise redirect to https)
if(process.env.NODE_ENV === 'production') {
    app.use((req, res, next) => {
      if (req.headers['x-forwarded-proto']?.split(',')[0] !== 'https')
        res.redirect(`https://${req.header('host')}${req.url}`)
      else
        next()
    })
}



// Block possibly malicious bots
const blockedPatterns = process.env.BLOCK_BOT_URL.split(',');
const badBotMap = new Map(); // IP -> timestamp of block
const blockDuration = 48 * 60 * 60 * 1000; // 48 hours
app.use(async (req, res, next) => {
	// console.log('1')
    const ipAddress = await getIP(req);
    const fullUrl = req.protocol + '://' + req.get('host') + req.originalUrl;

    // Check if IP is already blocked
    const blockTime = badBotMap.get(ipAddress);
	// console.log(blockTime)
    if (blockTime && (Date.now() - blockTime) < blockDuration) {
        logger(req, res, 'general', { message: `[IP: ${ipAddress}] Still blocked: ${fullUrl}`, severity: 1 });
        return res.status(403).send('Nope.');
    }

    // Check for bad URL patterns
    const isBot = blockedPatterns.some(pattern => req.originalUrl.includes(pattern));
    if (isBot) {
        logger(req, res, 'error', { message: `[IP: ${ipAddress}] Blocked bot at: ${fullUrl}`, severity: 1 });
        badBotMap.set(ipAddress, Date.now());
        return res.status(403).send('No.');
    }

  next();
});

//CONNECTION TO MONGODB
const dbUrl = process.env.DB_URL
const connectToMongo = async () => {
  try {
    await mongoose.connect(process.env.DB_URL);
    console.log("MongoDB connected");
	// await initializeParkSearchCache(); // rebuild search cache immediately on startup
  } catch (err) {
    console.error("MongoDB connection failed:", err);
    process.exit(1);
  }
};
connectToMongo();


// SESSION CONFIG
// Setting up Storing Session Stuff on DB_URL (using the connect-mongo npm app)
const secret = process.env.SESSION_SECRET;
const store = MongoStore.create({
	mongoUrl: dbUrl,
	touchAfter: 24 * 60 * 60, //24 hrs to update session when nothing has changed. Otherwise, if something does change, it'll update
	crypto:{
		secret, 
	}
});
store.on('error', e => logger(null,null,'error',{message:'Session store error', error:e}))
const sessionConfig= { // setting up the express-session (required for persistent logins with passport)
	store, //for the storeage of session stuff (using connect-mongo)
	name: process.env.COOKIE_NAME, //name of the cookie, so it's not too obvious what it is at first glance for hackers
	secret, // Secret for signing session ID
	resave: false, // No need to resave if not modified
	rolling: true, // Reset the cookie Max-Age on every request
	saveUninitialized: false,
	cookie: {
		httpOnly: true, //extra security so user can't see cookie details by writing a script on the user-side?
		//secure: true, // It is set to true in code below (when it's in production)
		expires: Date.now() + 1000 * 60 * 60 * 24, //milliseconds * sec * min * hrs * days (since date is written in milliseconds)
		maxAge: 1000 * 60 * 60 * 24, //    // 24 hrs
		sameSite: 'strict', // Helps prevent CSRF attacks (no cross-site cookies)
	}
}

// When using actual https (in production),  set cookies to only be sent over https
if(process.env.NODE_ENV === 'production') {
	sessionConfig.cookie.secure = true;
}

app.use(session(sessionConfig)); //make sure this remains located before passport.session

app.use(flash());
app.use(methodOverride('_method')); //using "_method" when doing POST, PUT, DELETE, which isn't recognized by default
app.use(cookieParser(process.env.CP_SEC));

// Don't enable, causes infinite errors
// app.use(mongoSanitize({
//   replaceWith: '_', // prevents `$`/`.` injection
// }));
// Custom basic sanitizer
app.use((req, res, next) => {
  const sanitize = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key in obj) {
      if (key.includes('$') || key.includes('.')) {
        delete obj[key];
      } else if (typeof obj[key] === 'object') {
        sanitize(obj[key]);
      }
    }
  };
  sanitize(req.body);
  sanitize(req.params);
  sanitize(req.query);
  next();
});

// Hide from users that it's using Express
app.disable("x-powered-by")

// Helmet config
const scriptSrcUrls = [
	'https://www.googletagmanager.com',
	'https://www.google-analytics.com'
	
];
const styleSrcUrls = [
	'https://cdnjs.cloudflare.com',
	'https://fonts.googleapis.com',

];
const connectSrcUrls = [

];
const fontSrcUrls = [
	'https://cdnjs.cloudflare.com'
];
app.use(
	helmet({
		crossOriginEmbedderPolicy: false, // to allow images to load
		xPoweredBy: false,
		frameguard: {action: 'deny'}, // Do not allow iframes (embed page route has its own override)
		referrerPolicy: { policy: "strict-origin-when-cross-origin" }, // Prevent privacy leaks
		hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }, //Enforce https
		noCache: false, // if true, then would be No cache so that things like loading icons don't show when user clicks "back" button, etc
		contentSecurityPolicy: {
			directives: {
				defaultSrc: ["'self'"],
				connectSrc: ["'self'", ...connectSrcUrls],
				scriptSrc: [ "'self'", "'unsafe-inline'", ...scriptSrcUrls], //
				styleSrc: ["'self'", "'unsafe-inline'", ...styleSrcUrls], // 
				workerSrc: ["'self'",], // "blob:"
				objectSrc: [],
				imgSrc: ["'self'","data:","blob:", `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`, 'https://img.youtube.com'], //,
				fontSrc: ["'self'", ...fontSrcUrls],
				frameAncestors: ["'self'"], // What websites to allow to embed this site's pages on their page
				frameSrc: ["'self'", 'https://www.youtube.com'], // What to allow to embed on this site (ex. Google Maps)
				upgradeInsecureRequests: [] // Forces HTTPS
			},
		},

	})
);

//PASSPORT SETUP
// Use the strategy that passport-local-mongoose provides
passport.use(User.createStrategy());
// Use the plugin's built-in serialization helpers
passport.serializeUser(User.serializeUser());
passport.deserializeUser(User.deserializeUser());

app.use(passport.initialize());
app.use(passport.session());

// // CSRF protection
// const csrfProtection = csrf({ cookie: true });
// app.use(csrfProtection);
// app.use((req, res, next) => {
//   res.locals.csrfToken = req.csrfToken();
//   next();
// });

// GET CURRENT USER DETAILS LOCALS MIDDLEWARE, AND SET IP
// Locals help us just write "success", "message", etc, directly in the .ejs files
app.use(async(req, res, next) => { 
	res.locals.currentUser = req.user;
	res.locals.success = req.flash('success'); 
    res.locals.info = req.flash('info'); 
    res.locals.warning = req.flash('warning');
    res.locals.error = req.flash('error');
	try{
		res.locals.ip = await getIP(req)
	} catch(err){
		res.locals.ip = null
	}
	
	next();
})

//WEBSITE-WIDE MESSAGES FROM MONGO DB

//REQUIRE ROUTE FILES
import userRoutes from './routes/users.js';
import campRoutes from './routes/camp.js';
import otherRoutes from './routes/other.js';
import adminRoutes from './routes/admin.js';
import crawlingRoutes from './routes/crawling.js';

//USE ROUTE FILES 
app.use('/user', userRoutes);
app.use('/camp', campRoutes);
app.use('/other', otherRoutes);
app.use('/a', adminRoutes);
app.use('/sitemap.xml', crawlingRoutes);

// Favicon Route
app.get('/favicon.ico', (req, res) => res.status(204).end());

//HOME PAGE
app.get('/', (req, res) => {
	// console.log(checkDefaultRegisterFields)
	// console.log('render home')
    return res.render(
		'home', 
		{
			meta: {
				title: 'Find a Park', 
				description:'See user-uploaded campsite photos and videos of Canadian national, provincial, and territorial parks, before you reserve a campsite.',
				url: `${process.env.CC_DOMAIN}`,
				image: `https://camppics.ca/images/images/home-hero-summer.jpg`,
			},
			data: { isHomepage: true}
		}
	);
});

// CATCH ALL NON-EXISTING ROUTES
// Store typical bot "incorrect URL" keywords in array
const ignoreURLAttempts = process.env.IGNORE_URL || []
//__________________________
app.all('/{*any}', (req, res, next) => { 
	// Don't notify admin about bots
	// console.log('in any')
	let foundBotUrl = false
	for(let keyword of ignoreURLAttempts){
		if(req.originalUrl.includes(keyword)){
			foundBotUrl = true
		}
	}

	// Don't notify admin about bots & If it's a non-existent route (that isn't in the list above)
    if (!foundBotUrl) {
        logger(null, null, 'error', { message: `Non-existent route visited: ${req.originalUrl}`, severity: 1 });
    }
	
	// return redirectedFlash(req, res, 'error', `That page does not exist, sorry.`, '/')
	return res.redirect('/')

})

//GENERIC ERROR HANDLER MIDDLEWARE
//All the error handler "next"s get carried over here for finalizing - this code has to be below all other route stuff
app.use(async (err,req,res,next) => {
	try{
		await logger(req, res, 'error', {message:`Error: tried URL: ${req.originalUrl}`, error: err})
	} catch(e) {
        console.error('Failed to log error');
	}

    if (res.headersSent) return next(err);
	return redirectedFlash(req, res, 'error', `Oops! An error has occurred: ${err.name}`, '/')
	
})

// UNHANDLED ERRORS
// Unhandled rejections
process.on('unhandledRejection', async (err) => {
	console.log('IN UNHANDLEDREJECTION', err)

	// If not some kind of issue with logger - need to do this to avoid infinite loop if it is a logging.js issue
	if(err.message && !err.message.toLowerCase().includes('logger error')){
		// Just in case, put it in a try-catch
		try {
			await logger(null,null,'error', {message: 'unhandledRejection', error: err});
		} catch (err) {
			console.error("Error when trying to use logger in unhandledRejection")
			// throw new Error('Sending from unhandledRejection to uncaughtException'); // so that other types of unhandled exceptions crash the server
			process.exit(1)
		}
		
		
	}
	console.log('THROWING ERROR FROM UNHANDLED REJECTION SPOT')
	// Send email/text to admin if possible before exiting?
	
	// throw new Error('Sending from unhandledRejection to uncaughtException'); // so that other types of unhandled exceptions crash the server
	process.exit(1)
	// return;
})
// Uncaught Exceptions
process.on('uncaughtException', async function (err) {
	console.log('IN UNCAUGHTEXCEPTION')
	// If it's not something with the logger
	if(err.message && !err.message.toLowerCase().includes('logger error')){
		await logger(null,null,'error', {message: 'uncaughtException error - crashing now...', error: err});
	} else {
		console.error('Logger error (as in, the logger malfunctioned)! Here is the error:')
		console.error('......................................')
		console.error(err)
		console.error('......................................')
	}
	// Send email/text to admin if possible before exiting?
	process.exit(1)
})


//PORT LISTENING
const port = process.env.PORT || 3000
app.listen(port, process.env.IP, function(){
	logger(null,null,'general', {message: `Camp Pics server started - listening on port ${port}...`});
});