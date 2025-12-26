import { Park } from '../models/park.js';

// Route to provide sitemap to scraper
export const sitemapXml = async (req, res, next) => {
    const parks = await Park.find({}, 'slug updatedAt').lean();

    const staticUrls = [
      { loc: 'https://www.camppics.ca/' },
      { loc: 'https://www.camppics.ca/camp/all-parks' },
      { loc: 'https://www.camppics.ca/other/faq' },
      { loc: 'https://www.camppics.ca/other/contact' },
      { loc: 'https://www.camppics.ca/other/privacy-and-terms' }
    ];
  
    const staticXml = staticUrls.map(u => {
      return `
        <url>
          <loc>${u.loc}</loc>
        </url>
      `;
    }).join('');
  
    const parkXml = parks.map(p => {
      return `
        <url>
          <loc>https://www.camppics.ca/camp/park/${p.slug}</loc>
          <lastmod>${p.updatedAt.toISOString()}</lastmod>
        </url>
      `;
    }).join('');
  
    const xml = `
      <urlset xmlns="https://www.sitemaps.org/schemas/sitemap/0.9">
        ${staticXml}
        ${parkXml}
      </urlset>
    `.trim();
  
    res.header('Content-Type', 'application/xml');
    res.send(xml);
};