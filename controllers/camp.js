import express from 'express';
import fs from 'fs';
import path from 'path';
import ParkSearch from '../models/parkSearch.js';
import { Park } from '../models/park.js';
import { toSlug } from '../utils/general.js'
import { isArray } from 'util';
import { redirectedFlash } from '../utils/redirectedFlash.js';


const router = express.Router();
const cacheDir = path.join(process.cwd(), 'cache');
const cacheFile = path.join(cacheDir, 'parkSearch.json');
const refreshIntervalHrs = 24;

let memoryCache = null;
let lastCacheTime = 0;

// Func to allow for accents and such
function normalizeText(str = '') {
  return str
    .normalize('NFD')                 // split accented letters
    .replace(/[\u0300-\u036f]/g, '')  // remove accents
    .toLowerCase();
}

// Function to load data into cache
export const loadCache = async (forceRefresh = false) => {
  // console.log('loading cache')
  // console.log(`lastCacheTime: ${lastCacheTime}`)
  const now = Date.now();
  const cacheExpired = now - lastCacheTime > refreshIntervalHrs * 60 * 60 * 1000;

  if (!forceRefresh && memoryCache && !cacheExpired) {
    return memoryCache;
  }

  try {
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

    // if (!forceRefresh && fs.existsSync(cacheFile)) {
    //   const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    //   if (data?.length) {
    //     memoryCache = data;
    //     lastCacheTime = now;
    //     return data;
    //   }
    // }

    // Check when cache file was last modified, and update if outdated
    if (!forceRefresh && fs.existsSync(cacheFile)) {
      const stats = fs.statSync(cacheFile);
      const fileModifiedTime = stats.mtimeMs;
      const cacheExpired = now - fileModifiedTime > refreshIntervalHrs * 60 * 60 * 1000;

      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

      if (data?.length && !cacheExpired) {
        memoryCache = data;
        lastCacheTime = fileModifiedTime; 
        return data;
      }
    }


    // Rebuild from DB
    // console.log('Refreshing ParkSearch cache from DB...');
    const parks = await ParkSearch.find({}).lean();

    // OLD WAY //
    // fs.writeFileSync(cacheFile, JSON.stringify(parks, null, 2));
    // memoryCache = parks;
    // lastCacheTime = now;
    // return parks;

    // IMPROVED QUICK WAY? //
    
    const enhanced = parks.map(p => ({
      ...p,
      _nameNorm: normalizeText(p.name),
      _provinceNorm: normalizeText(p.province),
      _keywordsNorm: (p.keywords || []).map(k => normalizeText(k))
    }));

    fs.writeFileSync(cacheFile, JSON.stringify(enhanced, null, 2));
    memoryCache = enhanced;
    lastCacheTime = now;
    return enhanced;
    
  } catch (err) {
    console.error('Cache load error:', err);
    return [];
  }
};

// Function for search score logic
function computeScore(entry, query) {
  const normalizedQuery = normalizeText(query);
  const terms = normalizedQuery.split(/\s+/);
  let score = 0;

  const name = normalizeText(entry.name);
  const province = normalizeText(entry.province);
  const keywords = (entry.keywords || []).map(k => normalizeText(k));

  for (const term of terms) {
    if (!term) continue;

    // Name matches (highest)
    if (name === term) score += 10;
    else if (name.includes(term)) score += 5;

    // Province matches
    if (province === term) score += 4;
    else if (province.includes(term)) score += 2;

    // Keywords
    if (keywords.includes(term)) score += 3;
    else if (keywords.some(k => k.includes(term))) score += 1;
  }

  return score;
}


// Functon to highlight text
function highlight(text, query) {
  if (!text || !query) return text;

  const normText = normalizeText(text);
  const normQuery = normalizeText(query);

  let result = '';
  let lastIndex = 0;

  const idx = normText.indexOf(normQuery);
  if (idx === -1) return text;

  // Map normalized index back to original string
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);

  return `${before}<mark>${match}</mark>${after}`;
}




export const searchApi = async(req, res, next) => {
    const { q } = req.query;
    const query = q?.trim().toLowerCase() || '';

    try {
        const { q } = req.query;
        if (!q || !q.trim()) return res.json([]);

        const query = q.trim().toLowerCase();
        const data = await loadCache();

        // Compute scores
        const scored = data.map(item => ({
            ...item,
            score: computeScore(item, query),
        }));

        // Filter out 0-score results
        const relevant = scored.filter(i => i.score > 0);

        // Sort: score desc, then parks before campgrounds
        relevant.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (a.type === 'park' && b.type === 'campground') return -1;
            if (a.type === 'campground' && b.type === 'park') return 1;
            return 0;
        });

        const results = relevant.slice(0, 25)

        // Return top N results
        res.json(results);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Search failed' });
    }
}

export const searchResults = async(req, res, next) => {
    const { q } = req.query;
    const slicedQuery = q.slice(0, 50)
    const query = slicedQuery?.trim().toLowerCase() || '';

    try {

        // If no query, show all parks 
        if (!query) {
          // const results = data.slice(0, 50)
          return res.redirect('/camp/all-parks')
        };

        const data = await loadCache();

        // Compute scores
        const scored = data.map(item => ({
            ...item,
            score: computeScore(item, query),
        }));

        // Filter out 0-score results
        const relevant = scored.filter(i => i.score > 0);

        // Sort: score desc, then parks before campgrounds
        relevant.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (a.type === 'park' && b.type === 'campground') return -1;
            if (a.type === 'campground' && b.type === 'park') return 1;
            return 0;
        });

        const results = relevant.slice(0, 50)
        // Attach highlighted versions (for EJS)
        const highlightedResults = results.map(r => ({
          ...r,
          _nameHighlighted: highlight(r.name, query),
          _parentHighlighted: r.parentPark ? highlight(r.parentPark, query) : null,
          _provinceHighlighted: highlight(r.province, query)
        }));

        // console.log(results)
        // If just one result:
        if(results.length == 1){
          // If this is a campground
          if(results[0]?.parentPark){
            return res.redirect(`/camp/park/${results[0].parentPark}#${results[0].name.toLowerCase()}`)
          } else {
            return res.redirect(`/camp/park/${results[0]?.name}`)
          }
        }
        // const resultsLength = Object.keys(results).length
        return res.render('parks/results', {
          meta: {
            title: `Search Results: ${query}`, 
          }, 
          data: {results: highlightedResults, query}, toSlug
        }) // data obj to avoid crashes
    } catch (err) {
        console.error(err);
        next(err)
    }
}

export const showAllParks = async (req, res, next) => {
  try {
    const results = await loadCache();

    const parks = results
      .filter(result => result.type === 'park')
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

    return res.render('parks/allParks', {
      meta: {
				title: 'Canadian Camping Parks', 
				description: 'Find Canadian national, provincial, and territorial parks that offer camping to share and see campsite photos and videos.',
				url: `${process.env.CC_DOMAIN}/camp/all-parks`,
        image: `https://camppics.ca/images/images/home-hero-autumn.jpg`,
			},
      parks,
      data: { currentPath: req.originalUrl }
    });
  } catch (err) {
    next(err);
  }
};


// Render park page
export const showPark = async (req, res, next) => {
  function naturalSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  }

  // Func to find approved park photo for social media (og:image)
  function findParkOgImage(park) {
    if (!Array.isArray(park.photos)) return null;
  
    const approved = park.photos.find(p => p.socialMediaApproved);
    return approved ? approved.url : null;
  }

  try {
    let { parkSlug } = req.params;
    parkSlug = toSlug(parkSlug);

    // Function to find an image for the park for og:image
    function findParkOgImage(park) {
      if (!Array.isArray(park.photos)) return null;
    
      const approved = park.photos.find(p => p.socialMediaApproved);
      return approved ? approved.url : null;
    }

    const park = await Park.findOne({ slug: parkSlug })
      .select(`
        name 
        slug 
        province 
        description
        sitesRanges

        photos.url
        photos.socialMediaApproved

        campgrounds.name 
        campgrounds.slug
        campgrounds.sitesRanges

        campgrounds.campsites.siteNumber 
        campgrounds.campsites.slug
        campgrounds.campsites.photos._id 
        campgrounds.campsites.videos._id

        campsites.siteNumber 
        campsites.slug
        photos.url
        photos.socialMediaApproved
      `)
      .lean();

      // Removed from above Dec 11, 2025:  campsites.photos._id  &  campsites.videos._id

    if (!park) {

      return redirectedFlash(req, res, 'error', `That page does not exist, sorry.`, '/')
    }

    // Add counts/flags for campsites inside campgrounds
    if (Array.isArray(park.campgrounds)) {
      park.campgrounds.sort((a, b) => naturalSort(a.name, b.name));
      for (const cg of park.campgrounds) {
        if (!Array.isArray(cg.campsites)) continue;

        // Sort alphatically and numerically
        cg.campsites.sort((a, b) => naturalSort(a.siteNumber, b.siteNumber));

        for (const cs of cg.campsites) {
          const photoCount = Array.isArray(cs.photos) ? cs.photos.length : 0;
          const videoCount = Array.isArray(cs.videos) ? cs.videos.length : 0;
          cs.photoCount = photoCount;
          cs.videoCount = videoCount;
          cs.mediaCount = photoCount + videoCount;
          cs.hasMedia = cs.mediaCount > 0;
          delete cs.photos;
          delete cs.videos;
        }
      }
    }

    // Add counts/flags for standalone campsites (parks without campgrounds)
    if (Array.isArray(park.campsites)) {
      for (const cs of park.campsites) {
        
        // Sort alphatically and numerically
        park.campsites.sort((a, b) => naturalSort(a.siteNumber, b.siteNumber));

        const photoCount = Array.isArray(cs.photos) ? cs.photos.length : 0;
        const videoCount = Array.isArray(cs.videos) ? cs.videos.length : 0;
        cs.photoCount = photoCount;
        cs.videoCount = videoCount;
        cs.mediaCount = photoCount + videoCount;
        cs.hasMedia = cs.mediaCount > 0;
        delete cs.photos;
        delete cs.videos;
      }
    }

    // console.log(park.campgrounds[0].campsites[0])

    // Social media sharing card image (og:image)
    const ogImage = findParkOgImage(park) || `${process.env.CC_DOMAIN}/images/images/home-hero-spring.jpg`;

    // Render
    return res.render('parks/showPark', 
    { 
      meta: {
				title: park.name, 
				description: `See and share photos and videos of campsites in ${park.name} in ${park.province}.`,
				url: `${process.env.CC_DOMAIN}/camp/park/${parkSlug}`,
        image: ogImage,
			},
      park, 
      data:{} 
    
    }); // data obj to avoid crashes
  } catch (err) {
    next(err);
  }
};


export const getPark = async(req, res, next) => {
  const park = await Park.findOne({ slug: req.params.parkSlug }).lean();
  if (!park) return res.status(404).json({ error: 'Not found' });
  // res.json({ photos: park.photos, videos: park.videos });
  return res.json({
    ...park,
    photos: park.photos.map(p => ({
      _id: p._id,
      user: p.user,
      url: p.url,
      caption: p.caption,
      username: p.username,
      dateTaken: p.dateTaken
    })),
    videos: park.videos.map(v => ({
      _id: v._id,
      user: v.user,
      url: v.url,
      caption: v.caption,
      username: v.username,
      dateTaken: v.dateTaken
    }))
  });
}

// If it's a park with no campgrounds
export const getCampsite = async (req, res, next) => {
  // console.log('getCampsite')
  const { parkSlug, campsiteSlug } = req.params;
  try {
    const park = await Park.findOne(
      { slug: parkSlug, 'campsites.slug': campsiteSlug },
      { 'campsites.$': 1 }
    ).lean();
    // If not found
    if (!park) return res.status(404).json({ error: 'Not found' });
    // Return it
    // return res.json(park.campsites[0]);
    const campsite = park.campsites[0]

    return res.json({
      ...campsite.toObject(),
      photos: campsite.photos.map(p => ({
        _id: p._id,
        user: p.user,
        url: p.url,
        caption: p.caption,
        username: p.username,
        dateTaken: p.dateTaken
      })),
      videos: campsite.videos.map(v => ({
        _id: v._id,
        user: v.user,
        url: v.url,
        caption: v.caption,
        username: v.username,
        dateTaken: v.dateTaken
      }))
    });

  } catch (err) { 
    next(err); 
  }
}

// If it's a park with campgrounds
export const getCampgroundCampsite = async (req, res, next) => {
  // console.log('getCampgroundCampsite')
  const { parkSlug, campgroundSlug, campsiteSlug } = req.params;
  // console.log({ parkSlug, campgroundSlug, campsiteSlug });
  try {

    const park = await Park.findOne(
      { slug: parkSlug, 'campgrounds.slug': campgroundSlug },
      { 'campgrounds.$': 1 }
    ).lean();
    // console.log(park)
    if (!park || !park.campgrounds?.length) return res.status(404).json({ error: 'Not found' });
    const campground = park.campgrounds[0];
    const campsite = campground.campsites.find(cs => cs.slug === campsiteSlug);
    // If not found
    if (!campsite) return res.status(404).json({ error: 'Not found' });
    // Return it
    return res.json(campsite);

  } catch (err) { 
    next(err); 
  }
}