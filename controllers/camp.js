import express from 'express';
import fs from 'fs';
import path from 'path';
import ParkSearch from '../models/parkSearch.js';
import { Park } from '../models/park.js';
import { toSlug } from '../utils/general.js'
import { isArray } from 'util';
import { redirectedFlash } from '../utils/redirectedFlash.js';
import { serializeForInlineScript } from '../utils/serializeForInlineScript.js';
import {
  CampsiteTargetError,
  resolveCampsiteTarget,
  sendCampsiteTargetError,
} from '../utils/campsiteTarget.js';
import { serializeCampsiteForClient } from '../utils/campsiteSerializer.js';


const router = express.Router();
const cacheDir = path.join(process.cwd(), 'cache');
const cacheFile = path.join(cacheDir, 'parkSearch.json');
const refreshIntervalHrs = 24;

export const SHOW_PARK_PROJECTION = `
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
  campsites.photos._id
  campsites.videos._id
`;

export const CAMPSITE_LOCATION_PROJECTION = {
  _id: 1,
  'campgrounds._id': 1,
  'campgrounds.name': 1,
  'campgrounds.slug': 1,
  'campgrounds.campsites._id': 1,
  'campgrounds.campsites.slug': 1,
  'campsites._id': 1,
  'campsites.slug': 1,
};

let memoryCache = null;
let lastCacheTime = 0;

function naturalSort(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function addCampsiteMediaCounts(campsites) {
  if (!Array.isArray(campsites)) return;

  campsites.sort((a, b) => naturalSort(a.siteNumber, b.siteNumber));
  for (const campsite of campsites) {
    const photoCount = Array.isArray(campsite.photos) ? campsite.photos.length : 0;
    const videoCount = Array.isArray(campsite.videos) ? campsite.videos.length : 0;
    campsite.photoCount = photoCount;
    campsite.videoCount = videoCount;
    campsite.mediaCount = photoCount + videoCount;
    campsite.hasMedia = campsite.mediaCount > 0;
    delete campsite.photos;
    delete campsite.videos;
  }
}

export function prepareCampsiteMediaCounts(park) {
  if (Array.isArray(park?.campgrounds)) {
    park.campgrounds.sort((a, b) => naturalSort(a.name, b.name));
    for (const campground of park.campgrounds) {
      addCampsiteMediaCounts(campground.campsites);
    }
  }

  addCampsiteMediaCounts(park?.campsites);
  return park;
}

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
      parksJson: serializeForInlineScript(parks),
      data: { currentPath: req.originalUrl }
    });
  } catch (err) {
    next(err);
  }
};


// Render park page
export const showPark = async (req, res, next) => {
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
      .select(SHOW_PARK_PROJECTION)
      .lean();

    if (!park) {

      return res.status(404).render('404', {
        meta: {
          title: 'Page not found',
          description: 'This page does not exist.',
        },
        data:{}
      });
    }

    prepareCampsiteMediaCounts(park);

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
      parkPageJson: serializeForInlineScript({
        slug: park.slug,
        name: park.name,
      }),
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

function exactMediaExpression(sourcePath) {
  return {
    $map: {
      input: { $ifNull: [sourcePath, []] },
      as: 'media',
      in: {
        _id: '$$media._id',
        user: '$$media.user',
        url: '$$media.url',
        caption: '$$media.caption',
        username: '$$media.username',
        dateTaken: '$$media.dateTaken',
        uploadedAt: '$$media.uploadedAt',
      },
    },
  };
}

function exactCampsiteExpression(sourcePath) {
  return {
    _id: `${sourcePath}._id`,
    siteNumber: `${sourcePath}.siteNumber`,
    slug: `${sourcePath}.slug`,
    type: `${sourcePath}.type`,
    photos: exactMediaExpression(`${sourcePath}.photos`),
    videos: exactMediaExpression(`${sourcePath}.videos`),
  };
}

export function buildExactCampsitePipeline(parkId, resolvedLocation) {
  const campsiteId = resolvedLocation?.campsite?._id;
  if (!parkId || !campsiteId) {
    throw new CampsiteTargetError('EXACT_TARGET_NOT_FOUND');
  }

  return [
    { $match: { _id: parkId } },
    {
      $project: {
        _id: 0,
        matches: {
          $concatArrays: [
            {
              $map: {
                input: {
                  $filter: {
                    input: { $ifNull: ['$campsites', []] },
                    as: 'campsite',
                    cond: { $eq: ['$$campsite._id', campsiteId] },
                  },
                },
                as: 'campsite',
                in: {
                  kind: { $literal: 'standalone-campsite' },
                  campground: null,
                  campsite: exactCampsiteExpression('$$campsite'),
                },
              },
            },
            {
              $reduce: {
                input: {
                  $map: {
                    input: { $ifNull: ['$campgrounds', []] },
                    as: 'campground',
                    in: {
                      $map: {
                        input: {
                          $filter: {
                            input: {
                              $ifNull: ['$$campground.campsites', []],
                            },
                            as: 'campsite',
                            cond: {
                              $eq: ['$$campsite._id', campsiteId],
                            },
                          },
                        },
                        as: 'campsite',
                        in: {
                          kind: { $literal: 'campground-campsite' },
                          campground: {
                            _id: '$$campground._id',
                            slug: '$$campground.slug',
                            name: '$$campground.name',
                          },
                          campsite: exactCampsiteExpression('$$campsite'),
                        },
                      },
                    },
                  },
                },
                initialValue: [],
                in: { $concatArrays: ['$$value', '$$this'] },
              },
            },
          ],
        },
      },
    },
    {
      $project: {
        _id: 0,
        matchCount: { $size: '$matches' },
        location: {
          $cond: [
            { $eq: [{ $size: '$matches' }, 1] },
            { $arrayElemAt: ['$matches', 0] },
            null,
          ],
        },
      },
    },
  ];
}

export async function loadCampsiteForClient(ParkModel, {
  parkSlug,
  campgroundSlug,
  campsiteSlug,
}) {
  const locationPark = await ParkModel.findOne(
    { slug: parkSlug },
    CAMPSITE_LOCATION_PROJECTION,
  ).lean();

  if (!locationPark) return null;

  const resolvedLocation = resolveCampsiteTarget(locationPark, {
    campgroundSlug,
    campsiteSlug,
  });
  const pipeline = buildExactCampsitePipeline(
    locationPark._id,
    resolvedLocation,
  );
  const exactRows = await ParkModel.aggregate(pipeline);
  const exactRow = Array.isArray(exactRows) ? exactRows[0] : null;
  const exactMatchCount = Number(exactRow?.matchCount ?? 0);

  if (exactMatchCount > 1) {
    throw new CampsiteTargetError('DUPLICATE_EXACT_CAMPSITE_ID');
  }

  const exactLocation = exactRow?.location;
  if (exactMatchCount !== 1 || !exactLocation?.campsite) {
    throw new CampsiteTargetError('EXACT_TARGET_NOT_FOUND');
  }

  const { kind, campsite } = exactLocation;
  const campground =
    kind === 'campground-campsite' ? exactLocation.campground : null;

  if (
    !['standalone-campsite', 'campground-campsite'].includes(kind) ||
    (kind === 'campground-campsite' && !campground)
  ) {
    throw new CampsiteTargetError('EXACT_TARGET_NOT_FOUND');
  }

  return {
    kind,
    target: campsite,
    campsite,
    campground,
    campsiteSlug: campsite.slug,
    campgroundSlug: campground?.slug ?? null,
  };
}

async function getCampsiteByLocation(req, res, next, ParkModel) {
  const { parkSlug, campgroundSlug, campsiteSlug } = req.params;

  try {
    let location;
    try {
      location = await loadCampsiteForClient(ParkModel, {
        parkSlug,
        campgroundSlug,
        campsiteSlug,
      });
    } catch (error) {
      if (sendCampsiteTargetError(res, error)) return;
      throw error;
    }

    if (!location) {
      return res.status(404).json({ error: 'Park not found.' });
    }

    return res.json(serializeCampsiteForClient(location));
  } catch (error) {
    next(error);
  }
}

export function createCampsiteApiHandlers({ ParkModel = Park } = {}) {
  return {
    getCampsite: (req, res, next) =>
      getCampsiteByLocation(req, res, next, ParkModel),
    getCampgroundCampsite: (req, res, next) =>
      getCampsiteByLocation(req, res, next, ParkModel),
  };
}

const campsiteApiHandlers = createCampsiteApiHandlers();

export const getCampsite = campsiteApiHandlers.getCampsite;
export const getCampgroundCampsite = campsiteApiHandlers.getCampgroundCampsite;
