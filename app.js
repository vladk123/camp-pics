import 'dotenv/config';
import express from 'express';
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
import methodOverride from 'method-override';
import helmet from 'helmet'
import rateLimiting from 'express-rate-limit' // For limiting how many requests made in a period of time
import speedLimiting from 'express-slow-down' // For limiting speed depending on how many requests made in a period of time
import { getIP } from './utils/getIP.js'
import {
	DEFAULT_BOT_BLOCK_DURATION_MS,
	DEFAULT_BOT_BLOCK_MAX_ENTRIES,
	BlockedClientCache,
} from './utils/blockedClientCache.js';
import {
	createBotUrlBlocker,
	createNotFoundHandler,
} from './utils/requestFilteringMiddleware.js';
import { initializeParkSearchCache } from './utils/cacheSearch.js';
import { enforceSessionAuthVersion } from './middleware.js';
import {
	csrfErrorHandler,
	csrfSynchronisedProtection,
	exposeCsrfToken,
} from './utils/csrf.js';

import flash from 'connect-flash';
import { redirectedFlash } from './utils/redirectedFlash.js';
import { logger } from './utils/logging.js'; //for logging errors
import { startWithRuntimeConfig } from './config/runtimeStartup.js';
import {
	createCspNonceMiddleware,
	cspNonceSource,
} from './utils/cspNonce.js';
import { consumeGa4Event } from './utils/ga4EventBootstrap.js';

import userRoutes from './routes/users.js';
import campRoutes from './routes/camp.js';
import otherRoutes from './routes/other.js';
import adminRoutes from './routes/admin.js';
import crawlingRoutes from './routes/crawling.js';

async function reportRuntimeConfigurationFailure({ message, issues }) {
	await logger(null, null, 'error', { message });
	for (const issue of issues) {
		await logger(null, null, 'error', {
			message: `Configuration issue: ${issue.variable} (${issue.reason}).`,
		});
	}
}

function startApplication(runtimeConfig) {
const app = express();
app.set('trust proxy', 1) // Since on Heroku/Digital Ocean (behind proxy), telling Express to trust proxy before using req.ip
app.use(compression())

// Skip rate limiting if loading public files
const skipPublicFiles = (req) => {
  return (
    req.path === '/favicon.ico' ||
    req.path.startsWith('/css/') ||
    req.path.startsWith('/js/') ||
    req.path.startsWith('/images/') ||
    req.path.startsWith('/font/') 
  );
};

// Doing overall limiting on all requests
const rateLimiterLong = rateLimiting({
  windowMs: 5 * 60 * 1000,
  max: runtimeConfig.requestLimits.fiveMinuteMaximum,
  message: 'Too many requests, please try again later.',
  skip: skipPublicFiles,
});
const speedLimiterLong = speedLimiting({
  windowMs: 1 * 60 * 1000,
  delayAfter: runtimeConfig.requestLimits.oneMinuteDelayAfter,
  delayMs: (hits) => hits * 1 * 1000,
  skip: skipPublicFiles,
});
app.use(rateLimiterLong)
app.use(speedLimiterLong)

//TO USE ON EVERY ROUTE
app.engine('ejs', ejsMate); //telling app to use this engine instead of default one
app.set('view engine', 'ejs'); //per the ejs docs
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.set('views', path.join(__dirname,'views')); //making sure "views" folder is relative to this file
app.use(express.urlencoded({ extended: true, limit: '10kb' })); //express's parser so that we can pass data from forms into db
app.use(express.json({limit: '10kb'})) // To parse the incoming requests with JSON payloads (found on SOF) - useful when passing data from fetch to route to use when POSTing
app.use(express.static(path.join(__dirname, 'public'))); //telling it to serve "public" directory (the public folder we created).

// CANONICAL URL middleware (must run before routes, for Google indexing) - works with the "canonicalUrl" in boilerplate.ejs
app.use((req, res, next) => {
  // Force canonical host + protocol
  const CANONICAL_HOST = 'https://camppics.ca';
  // req.path already excludes query string and hash
  res.locals.canonicalUrl = CANONICAL_HOST + req.path;
  next();
});

// If in production, check that it's on https (otherwise redirect to https)

if(runtimeConfig.environment.isProduction) {
    app.use((req, res, next) => {
      if (req.headers['x-forwarded-proto']?.split(',')[0] !== 'https')
        res.redirect(`https://camppics.ca${req.url}`)
      else
        next()
    })
}



// Block possibly malicious bots
const blockedPatterns = runtimeConfig.requestFiltering.blockedPatterns;
const botBlockCache = new BlockedClientCache({
	blockDurationMs: DEFAULT_BOT_BLOCK_DURATION_MS,
	maxEntries: DEFAULT_BOT_BLOCK_MAX_ENTRIES,
});
app.use(createBotUrlBlocker({
	blockedPatterns,
	cache: botBlockCache,
	getClientIp: getIP,
	reportEvent: logger,
}));

//CONNECTION TO MONGODB
const dbUrl = runtimeConfig.database.url
const connectToMongo = async () => {
  try {
    await mongoose.connect(dbUrl);
    console.log("MongoDB connected");
	// await initializeParkSearchCache(); // rebuild search cache immediately on startup
  } catch (err) {
    await logger(null, null, 'error', {
      message: 'MongoDB connection failed.',
      error: err,
    });
    process.exit(1);
  }
};
connectToMongo();


// SESSION CONFIG
// Setting up Storing Session Stuff on DB_URL (using the connect-mongo npm app)
const secret = runtimeConfig.session.secret;
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
	name: runtimeConfig.session.cookieName, //name of the cookie, so it's not too obvious what it is at first glance for hackers
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
if(runtimeConfig.environment.isProduction) {
	sessionConfig.cookie.secure = true;
}

app.use(session(sessionConfig)); //make sure this remains located before passport.session

app.use(flash());
app.use(methodOverride('_method')); //using "_method" when doing POST, PUT, DELETE, which isn't recognized by default

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
	'https://www.googletagmanager.com', // For Google Tag Manager (GA Analytics)
	'https://www.google-analytics.com' // For Google Tag Manager (GA Analytics)
	
];
const styleSrcUrls = [
	'https://cdnjs.cloudflare.com',
	'https://fonts.googleapis.com',
	'https://www.googletagmanager.com', // For Google Tag Manager (GA Analytics)
	'https://www.google-analytics.com' // For Google Tag Manager (GA Analytics)
];
const connectSrcUrls = [
	'https://www.googletagmanager.com', // For Google Tag Manager (GA Analytics)
	'https://www.google-analytics.com', // For tag manager to send GA4 analytics from actions
];
const fontSrcUrls = [
	'https://cdnjs.cloudflare.com'
];
app.use(createCspNonceMiddleware());
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
				scriptSrc: ["'self'", cspNonceSource, ...scriptSrcUrls], //
				scriptSrcAttr: ["'none'"],
				styleSrc: ["'self'", "'unsafe-inline'", ...styleSrcUrls], // 
				workerSrc: ["'self'",], // "blob:"
				objectSrc: [],
				imgSrc: ["'self'","data:","blob:", `https://res.cloudinary.com/${runtimeConfig.cloudinary.cloudName}/`, 'https://img.youtube.com', 'https://www.googletagmanager.com'], //,
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
app.use(enforceSessionAuthVersion);

// Registration and login controllers still persist the canonical request IP.
// Keep that compatibility value scoped to those POSTs instead of all views.
app.use(['/user/register', '/user/login'], (req, res, next) => {
	if (req.method === 'POST') res.locals.ip = getIP(req);
	next();
});

// GET CURRENT USER DETAILS LOCALS MIDDLEWARE
// Locals help us just write "success", "message", etc, directly in the .ejs files
app.use((req, res, next) => {
	res.locals.currentUser = req.user;
	res.locals.success = req.flash('success'); 
    res.locals.info = req.flash('info'); 
    res.locals.warning = req.flash('warning');
    res.locals.error = req.flash('error');

	// Google Analytics/Tag Manager (GA4). Consuming the session value here
	// preserves the existing one-time event behavior.
	res.locals.ga4EventJson = consumeGa4Event(req.session);

	next();
})

// Session-backed synchronizer-token protection. Body parsers, method override,
// Passport, and session-auth-version enforcement must run before this point.
app.use(csrfSynchronisedProtection);
app.use(exposeCsrfToken);

//WEBSITE-WIDE MESSAGES FROM MONGO DB

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
				url: runtimeConfig.publicSite.domain,
				image: `https://camppics.ca/images/images/home-hero-summer.jpg`,
			},
			data: { isHomepage: true}
		}
	);
});

// CATCH ALL NON-EXISTING ROUTES
// Store typical bot "incorrect URL" keywords in array
const ignoreURLAttempts = runtimeConfig.requestFiltering.ignoredNotFoundPatterns
//__________________________
app.all('/{*any}', createNotFoundHandler({
	ignoredPatterns: ignoreURLAttempts,
	reportEvent: logger,
}));

// Expected invalid-CSRF failures are handled without reaching the broad logger.
app.use(csrfErrorHandler);

//GENERIC ERROR HANDLER MIDDLEWARE
//All the error handler "next"s get carried over here for finalizing - this code has to be below all other route stuff
app.use(async (err,req,res,next) => {
	await logger(req, res, 'error', {
		message: 'Unhandled request error.',
		error: err,
	})

    if (res.headersSent) return next(err);
	return redirectedFlash(req, res, 'error', `Oops! An error has occurred: ${err.name}`, '/')
	
})

// UNHANDLED ERRORS
// Unhandled rejections
process.on('unhandledRejection', async (err) => {
	console.log('IN UNHANDLEDREJECTION')
	await logger(null,null,'error', {message: 'unhandledRejection', error: err});
	console.log('THROWING ERROR FROM UNHANDLED REJECTION SPOT')
	// Send email/text to admin if possible before exiting?
	
	// throw new Error('Sending from unhandledRejection to uncaughtException'); // so that other types of unhandled exceptions crash the server
	process.exit(1)
	// return;
})
// Uncaught Exceptions
process.on('uncaughtException', async function (err) {
	console.log('IN UNCAUGHTEXCEPTION')
	await logger(null,null,'error', {message: 'uncaughtException error - crashing now...', error: err});
	// Send email/text to admin if possible before exiting?
	process.exit(1)
})


//PORT LISTENING
const port = runtimeConfig.server.port
app.listen(port, runtimeConfig.server.host, function(){
	logger(null,null,'general', {message: `Camp Pics server started - listening on port ${port}...`});
});
}

await startWithRuntimeConfig({
	environment: process.env,
	start: startApplication,
	report: reportRuntimeConfigurationFailure,
});
