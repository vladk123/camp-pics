import { loadCache } from '../controllers/camp.js'

export const initializeParkSearchCache = async () => {
  console.log(' Initializing ParkSearch cache...');
  await loadCache(true);
  console.log(' ParkSearch cache initialized');
};